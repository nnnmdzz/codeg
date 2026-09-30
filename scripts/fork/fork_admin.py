#!/usr/bin/env python3
"""mobile fork：讓 fork 網頁在版本落後時觸發重建，並查詢進度。

只聽一個 unix socket，由 fork 的 nginx 容器把 /__fork/ 轉進來，不開任何
TCP 埠。每個請求都要帶 codeg 的 `Authorization: Bearer <token>`；本服務不
保存 token，而是原樣轉給 codeg 伺服器的 /api/health 驗證，順便取得伺服器
正在跑的版本。

能做的事只有兩件，都不接受參數：

  GET  /status  伺服器版本、fork 網頁的建置版本、更新服務的狀態
                （進行中或失敗時附上該次執行的最後幾行日誌）
  POST /update  啟動 codeg-web-fork-update.service（已在跑就沿用同一次）

更新本身就是定時器在跑的 scripts/fork/auto-update.sh：版本相同時什麼都不做，
rebase 衝突或建置失敗時停下、不部署。
"""

from __future__ import annotations

import json
import os
import re
import socketserver
import subprocess
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path

SOCKET = os.environ.get(
    "CODEG_FORK_ADMIN_SOCKET", "/run/codeg-fork-admin/admin.sock"
)
CODEG_URL = os.environ.get("CODEG_URL", "http://127.0.0.1:3080")
UNIT = os.environ.get("CODEG_FORK_UPDATE_UNIT", "codeg-web-fork-update.service")
TARGET = Path(os.environ.get("CODEG_FORK_WEB_DIR", "/usr/local/share/codeg/web-fork"))

LOG_LINES = 12
RUNNING_STATES = {"activating", "active", "reloading", "deactivating"}
SHOW_PROPS = (
    "ActiveState",
    "Result",
    "InvocationID",
    "ExecMainStartTimestamp",
    "ExecMainExitTimestamp",
)
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
INVOCATION_ID = re.compile(r"^[0-9a-f]{32}$")
# 驗 token 時直連本機的 codeg，絕不經過任何 proxy（token 不能外流）。
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Unreachable(Exception):
    """codeg 伺服器沒有回應，無法驗證 token。"""


def check_token(auth_header: str | None) -> str | None:
    """token 有效時回傳伺服器版本，無效回 None。"""
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    request = urllib.request.Request(
        f"{CODEG_URL}/api/health",
        data=b"{}",
        method="POST",
        headers={"Authorization": auth_header, "Content-Type": "application/json"},
    )
    try:
        with DIRECT.open(request, timeout=5) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            return None
        raise Unreachable(f"codeg answered {error.code}") from error
    except ValueError:
        # 標頭裡有換行之類的非法字元：http.client 拒絕送出，當作無效 token。
        return None
    except OSError as error:
        raise Unreachable(str(error)) from error
    return str(body.get("version") or "")


def run(*cmd: str) -> str:
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=10, check=False
    )
    if result.returncode != 0:
        # 失敗原因留在本服務的 journal，方便查沙箱設定是否擋到什麼。
        print(
            f"{cmd[0]} exited {result.returncode}: {result.stderr.strip()}",
            file=sys.stderr,
            flush=True,
        )
    return result.stdout


def show() -> dict[str, str]:
    out = run(
        "systemctl",
        "show",
        UNIT,
        "--timestamp=unix",
        f"--property={','.join(SHOW_PROPS)}",
    )
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def unix_time(value: str | None) -> int | None:
    # --timestamp=unix 的格式是 "@1790731494"；從沒跑過時是空字串。
    if value and value.startswith("@") and value[1:].isdigit():
        return int(value[1:])
    return None


def journal(invocation_id: str) -> list[str]:
    if not INVOCATION_ID.match(invocation_id):
        return []
    out = run(
        "journalctl",
        f"_SYSTEMD_INVOCATION_ID={invocation_id}",
        "--output=cat",
        "--no-pager",
        f"--lines={LOG_LINES}",
    )
    return [ANSI.sub("", line) for line in out.splitlines() if line.strip()]


def updater_state(props: dict[str, str]) -> dict:
    active = props.get("ActiveState", "")
    if active in RUNNING_STATES:
        state = "running"
    elif active == "failed" or props.get("Result", "success") != "success":
        state = "failed"
    else:
        state = "idle"
    started = unix_time(props.get("ExecMainStartTimestamp"))
    info: dict = {
        "state": state,
        "startedAt": started,
        "finishedAt": None
        if state == "running"
        else unix_time(props.get("ExecMainExitTimestamp")),
        "elapsed": int(time.time()) - started
        if state == "running" and started
        else None,
        "log": [],
    }
    if state != "idle":
        info["log"] = journal(props.get("InvocationID", ""))
    return info


def build_info() -> dict:
    try:
        lines = (TARGET / ".fork-build").read_text().splitlines()
    except OSError:
        lines = []

    def line(i: int) -> str | None:
        return lines[i].strip() or None if len(lines) > i else None

    built = line(0)
    return {
        "built": built.removeprefix("v") if built else None,
        "commit": line(1),
        "builtAt": line(2),
    }


def status(server: str) -> dict:
    return {"server": server, **build_info(), "updater": updater_state(show())}


def trigger() -> None:
    before = show().get("InvocationID")
    run("systemctl", "start", "--no-block", "--no-ask-password", UNIT)
    # --no-block 在排入工作後就返回。等它真的開始（或已經跑完，例如版本
    # 相同時一下就結束），回應裡的狀態才不會還是上一次的。
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        props = show()
        if (
            props.get("ActiveState") in RUNNING_STATES
            or props.get("InvocationID") != before
        ):
            return
        time.sleep(0.1)


class Handler(BaseHTTPRequestHandler):
    server_version = "codeg-fork-admin"
    sys_version = ""
    timeout = 15

    def address_string(self) -> str:
        # unix socket 沒有對端位址；唯一的對端就是 nginx 容器。
        return "nginx"

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/status":
            self.respond(update=False)
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] == "/update":
            self.respond(update=True)
        else:
            self.send_json(404, {"error": "not found"})

    def respond(self, update: bool) -> None:
        try:
            server = check_token(self.headers.get("Authorization"))
        except Unreachable as error:
            self.log_message("codeg unreachable: %s", error)
            self.send_json(502, {"error": "codeg server unreachable"})
            return
        if server is None:
            self.send_json(401, {"error": "unauthorized"})
            return
        if update:
            self.log_message("update requested")
            trigger()
        self.send_json(202 if update else 200, status(server))

    def send_json(self, code: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def serve(path: str = SOCKET) -> Server:
    socket_path = Path(path)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    socket_path.unlink(missing_ok=True)
    server = Server(path, Handler)
    # nginx 容器裡的 worker 不是 root，要能連進來；能不能用由 token 決定。
    os.chmod(path, 0o666)
    return server


def main() -> None:
    with serve() as server:
        print(f"listening on {SOCKET}", file=sys.stderr, flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
