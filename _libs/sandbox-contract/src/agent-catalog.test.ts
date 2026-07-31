import { describe, expect, it, test } from "vitest";
import {
    type AgentCapabilities,
    capabilitiesOf,
    clampMode,
    effortAllowed,
    HARNESSES,
    limitationsOf,
    modesFor,
    PROVIDERS,
    sendableEffort,
} from "./agent-catalog.js";
import type { AgentHarness, AgentProvider, PermissionMode } from "./schemas.js";

/* THE MATRIX GUARD.
 *
 * Four runtimes serve turns behind one seam, and for a long time the only record of what each could do was a
 * comment inside its own adapter. The surfaces above them could not read those, so they offered the same
 * controls to all four: a permission mode to a runtime with no approval channel, an effort scale to one that
 * drops the field. The record is what fixed that, and this is what keeps it honest.
 *
 * By SHAPE, not by a list: PROVIDERS × HARNESSES comes from the catalog itself, so a provider added tomorrow is
 * covered the day it is added. If a pair fails here, the answer is a row in capabilitiesOf — never a special
 * case in the surface that asked. */

const pairs: { provider: AgentProvider; harness: AgentHarness }[] = PROVIDERS.flatMap((provider) =>
    HARNESSES.map((harness) => ({ provider: provider.value as AgentProvider, harness: harness.value })),
);

describe("every provider/harness pair declares what it can do", () => {
    it.each(pairs)("$provider on the $harness harness", ({ provider, harness }) => {
        const capabilities = capabilitiesOf(provider, harness);

        // Nothing may be left to inference: a `permissions` a surface can't read, or a runtime nobody serves,
        // is the drift this record exists to end.
        expect(["claude-code", "codex", "opencode", "acp"]).toContain(capabilities.runtime);
        expect(["modes", "plan"]).toContain(capabilities.permissions);
        expect(["full", "http", "none"]).toContain(capabilities.mcp);
        expect(["namespace", "cwd"]).toContain(capabilities.isolation);
        // The permission modes offered must include the mode a clamp falls back to — a floor that isn't in the
        // list would leave the composer showing a posture the runtime can't hold.
        expect(modesFor(capabilities)).toContain(clampMode("default", capabilities));
    });
});

// An ACP provider is an installed capability's id — any string that isn't a native provider. It gets the ACP
// floor whatever harness the client happened to send, because the agent IS its own loop.
test("an unknown provider id is an ACP agent, on either harness", () => {
    for (const harness of HARNESSES) {
        expect(capabilitiesOf("some-installed-agent", harness.value).runtime).toBe("acp");
    }
});

/* The harness axis is real for exactly two providers. Claude is always its own Claude Code loop, and kimi/gemini
 * have no native runtime at all (Moonshot speaks the Anthropic protocol directly; Google is re-served through
 * the translator), so all three run it whatever the client sent — which is why "is the harness claude-code" was
 * never the question worth asking. */
test("only codex and grok change runtime with the harness", () => {
    const switched = PROVIDERS.filter((provider) => capabilitiesOf(provider.value, "native") !== capabilitiesOf(provider.value, "claude-code"));

    expect(switched.map((provider) => provider.value)).toEqual(["codex", "grok"]);
});

test("codex and grok under the Claude Code harness get the full ceiling — it is the same loop", () => {
    for (const provider of ["codex", "grok"] as const) {
        expect(capabilitiesOf(provider, "claude-code")).toEqual(capabilitiesOf("claude", "native"));
    }
});

// The composer's four modes describe behaviours the Claude Code loop actually has. A runtime whose every tool
// call is pre-approved has two postures, so it is offered two names — not four names for two behaviours.
test("a plan-only runtime offers the two postures it has", () => {
    expect(modesFor(capabilitiesOf("codex", "native"))).toEqual(["plan", "bypassPermissions"]);
    expect(modesFor(capabilitiesOf("claude", "native"))).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
});

test("a mode the runtime can't hold falls back to the one it runs; one it can holds", () => {
    const codex = capabilitiesOf("codex", "native");

    expect(clampMode("acceptEdits", codex)).toBe("bypassPermissions");
    expect(clampMode("plan", codex)).toBe("plan");
    expect(clampMode("acceptEdits", capabilitiesOf("claude", "native"))).toBe("acceptEdits");
});

/* The user-facing half. The full ceiling says nothing — an empty list is what hides the picker's block — and
 * every axis the record carries has a sentence here, because a capability nobody can read is how this started. */
test("the ceiling has nothing to disclose; a floor names what it lacks", () => {
    expect(limitationsOf(capabilitiesOf("claude", "native"))).toEqual([]);

    const grok = limitationsOf(capabilitiesOf("grok", "native"));
    expect(grok).toContain("no per-tool approvals");
    expect(grok).toContain("no mid-turn steering");
    expect(grok).toContain("no effort control");
    expect(grok).toContain("worktree by working directory only");

    // ACP takes our http MCP tools when it advertises them, so its line is a narrowing rather than an absence —
    // and it publishes commands and terminals, which must NOT be listed as missing.
    const acp = limitationsOf(capabilitiesOf("some-installed-agent", "native"));
    expect(acp).toContain("MCP tools only — no plugins or browser");
    expect(acp).not.toContain("no slash commands");
    expect(acp).not.toContain("no terminal panel");
});

test("every axis a record can lack has words for it", () => {
    const nothing: AgentCapabilities = {
        runtime: "acp",
        steering: false,
        permissions: "plan",
        questions: false,
        mcp: "none",
        effort: false,
        isolation: "cwd",
        commands: false,
        terminals: false,
        recovery: false,
    };

    // Nine axes, nine sentences: an axis added to the interface without one would silently never be disclosed.
    expect(limitationsOf(nothing)).toHaveLength(9);
});

// The mode vocabulary is the contract's own PermissionMode, so a mode added to the wire can't be quietly absent
// from the runtime that owns them all.
test("the Claude Code loop offers every PermissionMode the wire has", () => {
    const wire: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

    expect([...modesFor(capabilitiesOf("claude", "native"))].toSorted()).toEqual(wire.toSorted());
});

/* `max` + thinking-off is a 400 that kills the turn before the model sees it, and a session met it as "every
 * web search fails". The picker cannot be the only guard: a route, an extension or a restored tab assembles a
 * turn without ever passing through it. */
describe("the max-effort rule", () => {
    it("is unreachable in a picker: only Claude with extended thinking may offer it", () => {
        expect(effortAllowed("max", "claude", true)).toBe(true);
        expect(effortAllowed("max", "claude", false)).toBe(false);
        expect(effortAllowed("max", "codex", true)).toBe(false);
        // Every other tier is a property of the model's own scale, and nothing here constrains it.
        expect(effortAllowed("high", "kimi", false)).toBe(true);
    });

    it("is repaired, not refused, on the way to the API — the tier drops, the user's thinking choice does not", () => {
        expect(sendableEffort("max", false)).toBe("high");
        expect(sendableEffort("max", undefined)).toBe("high");
        expect(sendableEffort("max", true)).toBe("max");
        expect(sendableEffort("high", false)).toBe("high");
        expect(sendableEffort(undefined, false)).toBeUndefined();
    });
});
