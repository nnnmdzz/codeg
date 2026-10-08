import type { ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// mobile fork：思考區塊預設展開（content-parts-renderer 的 ReasoningPart 傳
// defaultOpen）。上游元件本身的預設仍是收合，見 ai-elements/reasoning.test.tsx。

vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: ReactNode }) => (
    <div data-testid="reasoning-body">{children}</div>
  ),
  defaultRemarkPlugins: {},
  defaultRehypePlugins: {},
}))
vi.mock("@streamdown/cjk", () => ({ cjk: {} }))
vi.mock("@streamdown/math", () => ({ createMathPlugin: () => ({}) }))
vi.mock("@streamdown/mermaid", () => ({ mermaid: {} }))
vi.mock("@streamdown/code", () => ({
  code: { highlight: vi.fn(), supportsLanguage: vi.fn(() => true) },
}))
vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))
vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

import { ContentPartsRenderer } from "@/components/message/content-parts-renderer"
import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"

function renderReasoning(content: string, isStreaming = false) {
  const parts = [
    { type: "reasoning", content, isStreaming },
  ] as unknown as AdaptedContentPart[]
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={parts} role="assistant" />
    </NextIntlClientProvider>
  )
  return screen.getByRole("button")
}

describe("thinking blocks open by default (fork)", () => {
  it("shows a finished block's thinking without a click", () => {
    const trigger = renderReasoning("weighing the two options")
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("reasoning-body")).toHaveTextContent(
      "weighing the two options"
    )
  })

  it("shows thinking as it streams", () => {
    const trigger = renderReasoning("still thinking", true)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("reasoning-body")).toHaveTextContent(
      "still thinking"
    )
  })

  it("leaves a block with nothing to show closed", () => {
    const trigger = renderReasoning("   ")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("reasoning-body")).toBeNull()
  })

  it("can still be folded by the reader", async () => {
    const user = userEvent.setup()
    const trigger = renderReasoning("weighing the two options")
    await user.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })
})
