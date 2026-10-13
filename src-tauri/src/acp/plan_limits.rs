//! Subscription plan usage windows, as the agents themselves report them.
//!
//! Nothing here asks a provider for anything. Both sources are figures the
//! agent already has from its own traffic:
//!
//! - **Claude Pro/Max.** Claude Code reads the unified rate-limit headers of
//!   its own API responses; the SDK surfaces them as `rate_limit_event`, and
//!   claude-agent-acp forwards that on a `usage_update` as
//!   `_meta["_claude/rateLimit"]` ([`claude_plan_limits`]).
//! - **Codex on a ChatGPT plan.** Codex writes the same picture into its
//!   rollout on every `token_count` (`payload.rate_limits`), which the rollout
//!   parser reads ([`codex_plan_limits`]).
//!
//! API-key, Bedrock and Vertex sign-ins have no plan windows and report none.
//!
//! The windows belong to the account, not to a session: the live connections
//! of an agent launched on the same settings (`config_fingerprint` — the same
//! sign-in or provider) hold the same figures. A new connection starts from
//! what those connections know ([`known_plan_limits`]), and a report on one is
//! offered to the others ([`plan_limits_subscriber_task`]). A connection on
//! other settings shares nothing, so a session on an API-key provider never
//! shows a subscription's figures. A report never replaces a newer one
//! ([`superseding`]), so an older transcript or a slower connection cannot roll
//! the figures back.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use tokio::sync::{broadcast, Mutex};

use crate::acp::connection::AgentConnection;
use crate::acp::internal_bus::InternalEventBus;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::AcpEvent;
use crate::models::agent::AgentType;
use crate::models::conversation::PlanLimitWindow;
use crate::web::event_bridge::emit_with_state_built;

const FIVE_HOURS_MINUTES: u64 = 5 * 60;
const SEVEN_DAYS_MINUTES: u64 = 7 * 24 * 60;

/// Claude's limit ids name their windows; those with a fixed length get it.
fn claude_window_minutes(kind: &str) -> Option<u64> {
    if kind == "five_hour" {
        Some(FIVE_HOURS_MINUTES)
    } else if kind.starts_with("seven_day") {
        Some(SEVEN_DAYS_MINUTES)
    } else {
        None
    }
}

/// Claude's `utilization` is the `anthropic-ratelimit-unified-*-utilization`
/// header value: a fraction of the window, 0–1. Rounded to hundredths of a
/// percent so `0.57` reads as `57`, not `56.99999999999999`.
fn fraction_to_percent(value: &Value) -> Option<f64> {
    let fraction = value.as_f64()?;
    fraction
        .is_finite()
        .then(|| (fraction.clamp(0.0, 1.0) * 10_000.0).round() / 100.0)
}

fn percent(value: &Value) -> Option<f64> {
    let percent = value.as_f64()?;
    percent.is_finite().then(|| percent.clamp(0.0, 100.0))
}

/// Unix seconds. A value in milliseconds is scaled down rather than read as a
/// date tens of thousands of years out.
fn epoch_seconds(value: &Value) -> Option<i64> {
    let raw = value.as_f64()?;
    if !raw.is_finite() || raw <= 0.0 {
        return None;
    }
    let seconds = if raw > 1e12 { raw / 1000.0 } else { raw };
    Some(seconds.round() as i64)
}

/// The windows a Claude `usage_update` carries in `_meta["_claude/rateLimit"]`.
///
/// The payload is the SDK's `SDKRateLimitInfo`: the window this update is about
/// (`rateLimitType`, `utilization`, `resetsAt`, `status`), and — from CLIs that
/// include it — every window's figures under `unifiedWindows`. Both shapes are
/// read; `status` belongs to the `rateLimitType` window only. Empty when the
/// key is absent (API-key sessions, agents other than Claude) or says nothing
/// usable.
pub fn claude_plan_limits(meta: Option<&Map<String, Value>>) -> Vec<PlanLimitWindow> {
    let Some(info) = meta
        .and_then(|meta| meta.get("_claude/rateLimit"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };

    let mut windows: Vec<PlanLimitWindow> = Vec::new();
    if let Some(unified) = info.get("unifiedWindows").and_then(Value::as_object) {
        for (kind, window) in unified {
            let Some(window) = window.as_object() else {
                continue;
            };
            windows.push(PlanLimitWindow {
                kind: kind.clone(),
                used_percent: window.get("utilization").and_then(fraction_to_percent),
                resets_at: window.get("resetsAt").and_then(epoch_seconds),
                window_minutes: claude_window_minutes(kind),
                status: None,
            });
        }
    }

    if let Some(kind) = info.get("rateLimitType").and_then(Value::as_str) {
        let status = info
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string);
        let used_percent = info.get("utilization").and_then(fraction_to_percent);
        let resets_at = info.get("resetsAt").and_then(epoch_seconds);
        match windows.iter_mut().find(|window| window.kind == kind) {
            Some(window) => {
                window.status = status;
                window.used_percent = window.used_percent.or(used_percent);
                window.resets_at = window.resets_at.or(resets_at);
            }
            None => windows.push(PlanLimitWindow {
                kind: kind.to_string(),
                used_percent,
                resets_at,
                window_minutes: claude_window_minutes(kind),
                status,
            }),
        }
    }

    windows.retain(|window| window.used_percent.is_some() || window.resets_at.is_some());
    sort_windows(&mut windows);
    windows
}

/// The windows in a Codex rollout's `token_count.rate_limits`: `primary` and
/// `secondary`, each `{used_percent, window_minutes, resets_at}`. Older Codex
/// wrote `resets_in_seconds` instead of `resets_at`; that is resolved against
/// `observed_at`, the rollout line's own timestamp. Windows are named by their
/// length, so a weekly `primary` (some plans have only that) still reads as
/// weekly.
pub fn codex_plan_limits(
    rate_limits: &Value,
    observed_at: Option<DateTime<Utc>>,
) -> Vec<PlanLimitWindow> {
    let mut windows = Vec::new();
    for slot in ["primary", "secondary"] {
        let Some(window) = rate_limits.get(slot).and_then(Value::as_object) else {
            continue;
        };
        let window_minutes = window.get("window_minutes").and_then(Value::as_u64);
        let resets_at = window.get("resets_at").and_then(epoch_seconds).or_else(|| {
            let seconds = window.get("resets_in_seconds").and_then(Value::as_f64)?;
            let observed = observed_at?;
            (seconds.is_finite() && seconds >= 0.0)
                .then(|| observed.timestamp() + seconds.round() as i64)
        });
        let used_percent = window.get("used_percent").and_then(percent);
        if used_percent.is_none() && resets_at.is_none() {
            continue;
        }
        let kind = match window_minutes {
            Some(FIVE_HOURS_MINUTES) => "five_hour".to_string(),
            Some(SEVEN_DAYS_MINUTES) => "seven_day".to_string(),
            Some(minutes) => format!("window_{minutes}m"),
            None => slot.to_string(),
        };
        windows.push(PlanLimitWindow {
            kind,
            used_percent,
            resets_at,
            window_minutes,
            status: None,
        });
    }
    sort_windows(&mut windows);
    windows
}

/// Whether `incoming` should replace `held`, a window of the same kind. A later
/// reset time is a newer window. Within one window usage only grows, so the
/// higher share is the later report (and an equal one may carry a new
/// `status`). Anything else is stale — a connection that saw less, or an older
/// transcript — and is ignored.
fn supersedes(incoming: &PlanLimitWindow, held: &PlanLimitWindow) -> bool {
    if incoming == held {
        return false;
    }
    let resets = |window: &PlanLimitWindow| window.resets_at.unwrap_or(i64::MIN);
    let used = |window: &PlanLimitWindow| window.used_percent.unwrap_or(f64::NEG_INFINITY);
    match resets(incoming).cmp(&resets(held)) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => used(incoming) >= used(held),
    }
}

/// The incoming windows that would change `held`: new kinds, and those that
/// supersede the held window of their kind.
pub fn superseding(held: &[PlanLimitWindow], incoming: &[PlanLimitWindow]) -> Vec<PlanLimitWindow> {
    incoming
        .iter()
        .filter(
            |window| match held.iter().find(|held| held.kind == window.kind) {
                Some(held) => supersedes(window, held),
                None => true,
            },
        )
        .cloned()
        .collect()
}

/// Folds reported windows into the held set (see [`superseding`]): each
/// replaces the held window of its kind, the rest stay — one Claude update
/// usually speaks for a single window. Returns whether anything changed.
pub fn merge_plan_limits(held: &mut Vec<PlanLimitWindow>, incoming: &[PlanLimitWindow]) -> bool {
    let fresh = superseding(held, incoming);
    if fresh.is_empty() {
        return false;
    }
    for window in fresh {
        match held.iter_mut().find(|held| held.kind == window.kind) {
            Some(held) => *held = window,
            None => held.push(window),
        }
    }
    sort_windows(held);
    true
}

/// What the agent's live connections on these settings already know about the
/// plan: where a new connection of the same agent and settings starts.
pub async fn known_plan_limits(
    connections: &Mutex<HashMap<String, AgentConnection>>,
    agent_type: AgentType,
    config_fingerprint: &str,
) -> Vec<PlanLimitWindow> {
    let states: Vec<_> = connections
        .lock()
        .await
        .values()
        .filter(|connection| {
            connection.agent_type == agent_type
                && connection.config_fingerprint == config_fingerprint
        })
        .map(|connection| Arc::clone(&connection.state))
        .collect();
    let mut known = Vec::new();
    for state in states {
        merge_plan_limits(&mut known, &state.read().await.plan_limits);
    }
    known
}

/// Keeps an agent's live connections on the same figures. When a connection
/// reports windows (an `AcpEvent::PlanLimits` on the in-process bus), each
/// other connection of the same agent and settings takes whatever is newer
/// than what it holds, through its own stream so attached clients see it too.
/// The echo of that emit stops at once: the reporter already holds what it
/// reported.
///
/// Subscribes before returning, like `lifecycle_subscriber_task`, so nothing
/// emitted before the first poll is missed.
pub fn plan_limits_subscriber_task(
    manager: ConnectionManager,
    bus: Arc<InternalEventBus>,
) -> impl Future<Output = ()> + Send + 'static {
    let mut rx = bus.subscribe();
    async move {
        loop {
            let envelope = match rx.recv().await {
                Ok(envelope) => envelope,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
            let AcpEvent::PlanLimits { windows } = &envelope.payload else {
                continue;
            };
            let peers: Vec<_> = {
                let connections = manager.connections.lock().await;
                let Some(source) = connections.get(&envelope.connection_id) else {
                    continue;
                };
                connections
                    .values()
                    .filter(|connection| {
                        connection.agent_type == source.agent_type
                            && connection.config_fingerprint == source.config_fingerprint
                            && connection.id != source.id
                    })
                    .map(|connection| (Arc::clone(&connection.state), connection.emitter.clone()))
                    .collect()
            };
            for (state, emitter) in peers {
                emit_with_state_built(&state, &emitter, |held| {
                    let fresh = superseding(&held.plan_limits, windows);
                    (!fresh.is_empty()).then_some(AcpEvent::PlanLimits { windows: fresh })
                })
                .await;
            }
        }
    }
}

/// Shortest window first (the 5-hour one, then weekly), unknown lengths last,
/// then by name — a stable order for the UI.
fn sort_windows(windows: &mut [PlanLimitWindow]) {
    windows.sort_by(|a, b| {
        a.window_minutes
            .unwrap_or(u64::MAX)
            .cmp(&b.window_minutes.unwrap_or(u64::MAX))
            .then_with(|| a.kind.cmp(&b.kind))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(value: Value) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("_claude/rateLimit".into(), value);
        map
    }

    #[test]
    fn reads_the_window_a_claude_update_is_about() {
        let windows = claude_plan_limits(Some(&meta(json!({
            "status": "allowed_warning",
            "rateLimitType": "five_hour",
            "utilization": 0.82,
            "resetsAt": 1_791_000_000,
            "isUsingOverage": false
        }))));
        assert_eq!(
            windows,
            vec![PlanLimitWindow {
                kind: "five_hour".into(),
                used_percent: Some(82.0),
                resets_at: Some(1_791_000_000),
                window_minutes: Some(300),
                status: Some("allowed_warning".into()),
            }]
        );
    }

    #[test]
    fn reads_every_window_when_the_cli_includes_them() {
        let windows = claude_plan_limits(Some(&meta(json!({
            "status": "allowed",
            "rateLimitType": "seven_day",
            "unifiedWindows": {
                "seven_day": { "utilization": 0.57, "resetsAt": 1_791_500_000 },
                "five_hour": { "utilization": 0.1, "resetsAt": 1_791_010_000 }
            }
        }))));
        let kinds: Vec<_> = windows.iter().map(|w| w.kind.as_str()).collect();
        assert_eq!(kinds, ["five_hour", "seven_day"]);
        assert_eq!(windows[0].used_percent, Some(10.0));
        assert_eq!(windows[0].status, None);
        assert_eq!(windows[1].used_percent, Some(57.0));
        assert_eq!(windows[1].status.as_deref(), Some("allowed"));
    }

    #[test]
    fn says_nothing_without_the_claude_key_or_usable_figures() {
        assert!(claude_plan_limits(None).is_empty());
        assert!(claude_plan_limits(Some(&Map::new())).is_empty());
        assert!(claude_plan_limits(Some(&meta(json!({ "status": "allowed" })))).is_empty());
        assert!(claude_plan_limits(Some(&meta(json!("not an object")))).is_empty());
    }

    #[test]
    fn clamps_utilization_and_scales_milliseconds() {
        let windows = claude_plan_limits(Some(&meta(json!({
            "status": "rejected",
            "rateLimitType": "seven_day_opus",
            "utilization": 1.3,
            "resetsAt": 1_791_000_000_000_i64
        }))));
        assert_eq!(windows[0].used_percent, Some(100.0));
        assert_eq!(windows[0].resets_at, Some(1_791_000_000));
        assert_eq!(windows[0].window_minutes, Some(10_080));
    }

    #[test]
    fn names_codex_windows_by_their_length() {
        let windows = codex_plan_limits(
            &json!({
                "limit_id": "codex",
                "primary": { "used_percent": 92.0, "window_minutes": 10080, "resets_at": 1_788_106_606 },
                "secondary": null
            }),
            None,
        );
        assert_eq!(
            windows,
            vec![PlanLimitWindow {
                kind: "seven_day".into(),
                used_percent: Some(92.0),
                resets_at: Some(1_788_106_606),
                window_minutes: Some(10_080),
                status: None,
            }]
        );
    }

    #[test]
    fn resolves_older_codex_countdowns_against_the_line_time() {
        let observed = DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let windows = codex_plan_limits(
            &json!({
                "primary": { "used_percent": 12.5, "window_minutes": 300, "resets_in_seconds": 3600 },
                "secondary": { "used_percent": 40.0, "window_minutes": 10080, "resets_in_seconds": 86_400 }
            }),
            Some(observed),
        );
        assert_eq!(windows[0].kind, "five_hour");
        assert_eq!(windows[0].resets_at, Some(observed.timestamp() + 3600));
        assert_eq!(windows[1].kind, "seven_day");
        assert_eq!(windows[1].resets_at, Some(observed.timestamp() + 86_400));
    }

    #[test]
    fn codex_with_no_plan_says_nothing() {
        let windows = codex_plan_limits(
            &json!({ "limit_id": "codex", "primary": null, "secondary": null, "credits": null }),
            None,
        );
        assert!(windows.is_empty());
    }

    #[test]
    fn a_stale_report_never_rolls_the_figures_back() {
        let window = |used: f64, resets_at: i64| PlanLimitWindow {
            kind: "five_hour".into(),
            used_percent: Some(used),
            resets_at: Some(resets_at),
            window_minutes: Some(300),
            status: None,
        };
        let mut held = vec![window(62.0, 2_000)];
        // Same window, less used: a slower connection, or an older transcript.
        assert!(!merge_plan_limits(&mut held, &[window(40.0, 2_000)]));
        // An earlier window altogether.
        assert!(!merge_plan_limits(&mut held, &[window(90.0, 1_000)]));
        assert_eq!(held, vec![window(62.0, 2_000)]);
        // A later window replaces it, even though less of it is used.
        assert!(merge_plan_limits(&mut held, &[window(5.0, 3_000)]));
        assert_eq!(held, vec![window(5.0, 3_000)]);
        // Same figures with a new verdict is news.
        let mut warned = window(5.0, 3_000);
        warned.status = Some("allowed_warning".into());
        assert_eq!(
            superseding(&held, std::slice::from_ref(&warned)),
            vec![warned]
        );
    }

    #[test]
    fn merging_replaces_a_window_of_the_same_kind_and_keeps_the_rest() {
        let five = |used: f64| PlanLimitWindow {
            kind: "five_hour".into(),
            used_percent: Some(used),
            resets_at: Some(1),
            window_minutes: Some(300),
            status: None,
        };
        let week = PlanLimitWindow {
            kind: "seven_day".into(),
            used_percent: Some(50.0),
            resets_at: Some(2),
            window_minutes: Some(10_080),
            status: None,
        };
        let mut held = vec![week.clone()];
        assert!(merge_plan_limits(&mut held, &[five(10.0)]));
        assert_eq!(held, vec![five(10.0), week.clone()]);
        assert!(!merge_plan_limits(&mut held, &[five(10.0)]));
        assert!(merge_plan_limits(&mut held, &[five(30.0)]));
        assert_eq!(held, vec![five(30.0), week]);
    }

    fn window(kind: &str, used: f64, resets_at: i64, minutes: u64) -> PlanLimitWindow {
        PlanLimitWindow {
            kind: kind.into(),
            used_percent: Some(used),
            resets_at: Some(resets_at),
            window_minutes: Some(minutes),
            status: None,
        }
    }

    /// Two Claude connections on the same settings, one on other settings
    /// (another provider or sign-in), and a Codex one.
    async fn manager_with_peers() -> ConnectionManager {
        use crate::web::event_bridge::EventEmitter;
        let manager = ConnectionManager::new();
        for (id, agent_type) in [
            ("reporter", AgentType::ClaudeCode),
            ("peer", AgentType::ClaudeCode),
            ("other-settings", AgentType::ClaudeCode),
            ("codex", AgentType::Codex),
        ] {
            manager
                .insert_test_connection(id, agent_type, None, EventEmitter::Noop)
                .await;
        }
        manager
            .connections
            .lock()
            .await
            .get_mut("other-settings")
            .unwrap()
            .config_fingerprint = "api-key-provider".into();
        manager
    }

    async fn held(manager: &ConnectionManager, id: &str) -> Vec<PlanLimitWindow> {
        let state = Arc::clone(&manager.connections.lock().await[id].state);
        let windows = state.read().await.plan_limits.clone();
        windows
    }

    #[tokio::test]
    async fn a_report_reaches_the_agents_other_connections_on_the_same_settings() {
        use crate::acp::internal_bus::EventBusMetrics;
        use crate::acp::types::EventEnvelope;

        let manager = manager_with_peers().await;
        // The peer already holds a later 5-hour window than the report.
        let later = window("five_hour", 5.0, 3_000, 300);
        {
            let state = Arc::clone(&manager.connections.lock().await["peer"].state);
            state.write().await.plan_limits = vec![later.clone()];
        }

        let bus = Arc::new(InternalEventBus::new(Arc::new(EventBusMetrics::default())));
        let task = tokio::spawn(plan_limits_subscriber_task(
            manager.clone_ref(),
            Arc::clone(&bus),
        ));
        let week = window("seven_day", 30.0, 9_000, 10_080);
        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "reporter".into(),
            payload: AcpEvent::PlanLimits {
                windows: vec![window("five_hour", 80.0, 2_000, 300), week.clone()],
            },
        }));
        drop(bus);
        task.await.unwrap();

        assert_eq!(held(&manager, "peer").await, vec![later, week]);
        assert!(held(&manager, "other-settings").await.is_empty());
        assert!(held(&manager, "codex").await.is_empty());
        // The reporter's own figures are its own emit's business.
        assert!(held(&manager, "reporter").await.is_empty());
    }

    #[tokio::test]
    async fn a_new_connection_starts_from_its_peers_on_the_same_settings() {
        let manager = manager_with_peers().await;
        for (id, windows) in [
            ("reporter", vec![window("five_hour", 40.0, 2_000, 300)]),
            ("peer", vec![window("five_hour", 20.0, 2_000, 300)]),
            (
                "other-settings",
                vec![window("seven_day", 70.0, 9_000, 10_080)],
            ),
        ] {
            let state = Arc::clone(&manager.connections.lock().await[id].state);
            state.write().await.plan_limits = windows;
        }

        assert_eq!(
            known_plan_limits(&manager.connections, AgentType::ClaudeCode, "").await,
            vec![window("five_hour", 40.0, 2_000, 300)]
        );
        assert!(
            known_plan_limits(&manager.connections, AgentType::Codex, "")
                .await
                .is_empty()
        );
    }
}
