import { describe, expect, it } from "bun:test";
import { metadataSession, stableUuid } from "../src/identity.ts";
import { accountMachine, pinMachineEnvironment } from "../src/machine.ts";
import { agentBody, agentHeaders } from "../src/profile.ts";
import { alignBillingSuffix, assertOutgoingShape, canonicalBetas, canonicalBodyOrder, ccBuildSuffix, nativeBetas, normalizeThinking, ShapeError } from "../src/shape.ts";
import type { RuntimeAccount } from "../src/types.ts";

const account: RuntimeAccount = {
  id: "account-0",
  baseUrl: "https://api.anthropic.com",
  accessToken: "token",
  proxy: "http://proxy",
  deviceId: "a".repeat(64),
};

describe("Claude Code outgoing shape", () => {
  it("recomputes suffix-v1 from the outgoing first user text, not a captured constant", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "Reply with exactly OK." }] }];
    expect(ccBuildSuffix(messages)).toBe("93a");
    expect(ccBuildSuffix([{ role: "user", content: "different prompt" }])).not.toBe("93a");
    const withReminder = [{ role: "user", content: [{ type: "text", text: "<system-reminder>ignored</system-reminder>" }, ...messages[0].content] }];
    expect(ccBuildSuffix(withReminder)).toBe("93a");
  });

  it("generates deterministic UUIDv4 sessions and reads legacy metadata", () => {
    const a = stableUuid("conversation-a");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableUuid("conversation-a")).toBe(a);
    expect(metadataSession(`user_${"b".repeat(64)}_account_x_session_${a}`)).toBe(a);
  });

  it("puts OAuth beta immediately after claude-code and preserves feature betas", () => {
    const betas = canonicalBetas(true, "effort-2025-11-24").split(",");
    expect(betas[0]).toBe("claude-code-20250219");
    expect(betas[1]).toBe("oauth-2025-04-20");
    expect(betas.at(-1)).toBe("effort-2025-11-24");
  });

  it("preserves native feature betas without enabling deferred tooling on every request", () => {
    const betas = nativeBetas(true, "interleaved-thinking-2025-05-14").split(",");
    expect(betas).toEqual(["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"]);
    expect(betas).not.toContain("advanced-tool-use-2025-11-20");
    expect(betas).not.toContain("mid-conversation-tool-changes-2026-07-01");
  });

  it("uses one account machine for headers and environment blocks", () => {
    const machine = accountMachine(account);
    const session = stableUuid("machine");
    const body = {
      messages: [{ role: "system", content: "# Environment\nYou are invoked in the following environment:\n - Primary working directory: /Users/alice/project\n - Platform: darwin\n - Shell: zsh\n - OS Version: Darwin 25.0\n - Scratchpad directory: /Users/alice/.claude/projects/x/scratchpad — local" }],
    };
    const out = pinMachineEnvironment(body, machine, session);
    expect(out.messages[0].content).toContain(machine.workingDir);
    expect(out.messages[0].content).toContain("Platform: linux");
    expect(out.messages[0].content).toContain(machine.profile.osVersion);
    expect(out.messages[0].content).not.toContain("/Users/alice");
    expect(out.messages[0].content).toContain(session);
  });

  it("normalizes modern thinking without dropping display or other intent", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 1000, display: "omitted" } };
    expect(normalizeThinking(body, "claude-opus-5-5").thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(normalizeThinking(body, "claude-sonnet-4-5-20250929").thinking.budget_tokens).toBe(1000);
  });

  it("accepts a complete outgoing profile and rejects a stale suffix before egress", () => {
    const session = stableUuid("shape");
    const body = agentBody({ model: "claude-sonnet-4-5-20250929", messages: [{ role: "user", content: "Say OK" }], max_tokens: 128, stream: true }, "claude-sonnet-4-5-20250929", account, session);
    const headers = agentHeaders(session, account);
    expect(() => assertOutgoingShape(headers, alignBillingSuffix(body))).not.toThrow();
    const stale = agentBody({ model: "claude-sonnet-4-5-20250929", messages: [{ role: "user", content: "Say OK" }], max_tokens: 128, stream: true }, "claude-sonnet-4-5-20250929", account, session);
    stale.system[0].text = stale.system[0].text.replace(/cc_version=([^;]+)/, "cc_version=2.1.322.000");
    expect(() => assertOutgoingShape(headers, stale)).toThrow(ShapeError);
  });

  it("keeps metadata fields in Claude Code key order", () => {
    const session = stableUuid("order");
    const body = agentBody({ model: "claude-sonnet-4-5-20250929", messages: [], max_tokens: 1, stream: true }, "claude-sonnet-4-5-20250929", account, session);
    expect(body.metadata.user_id).toBe(`{"device_id":"${"a".repeat(64)}","account_uuid":"","session_id":"${session}"}`);
  });

  it("places temperature before output_config and stream like title-generation requests", () => {
    const body = canonicalBodyOrder({ model: "m", messages: [], system: [], tools: [], metadata: {}, max_tokens: 1, thinking: { type: "disabled" }, temperature: 0, output_config: { effort: "medium" }, stream: true });
    expect(Object.keys(body)).toEqual(["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "temperature", "output_config", "stream"]);
  });
});
