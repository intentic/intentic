import { describe, expect, it, test } from "vitest";
import {
    accessFor,
    type AgentCapabilities,
    capabilitiesOf,
    clampMode,
    effortAllowed,
    endpointIdOf,
    endpointProvider,
    fastAllowed,
    FREE_PROVIDERS,
    HARNESSES,
    isEndpointProvider,
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
        expect(["claude-code", "codex", "opencode", "opencode-gemini", "acp", "pi"]).toContain(capabilities.runtime);
        expect(["modes", "plan"]).toContain(capabilities.permissions);
        expect(["full", "http", "none"]).toContain(capabilities.mcp);
        expect(["namespace", "cwd"]).toContain(capabilities.isolation);
        expect(["replace", "append", "none"]).toContain(capabilities.instructions);
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

/* THE `pi` ID IS RESERVED for the Pi coding agent's own RPC runtime — an `agent`-kind capability like any ACP
 * agent, but served over Pi's JSONL protocol, which carries abilities the ACP floor cannot: real mid-turn
 * steering, the thinking-level scale, a published command list. Falling to the ACP record instead would strip
 * exactly the abilities that justify a fifth runtime. */
describe("the pi provider", () => {
    it("runs the pi runtime on either harness — pi is its own loop", () => {
        for (const harness of HARNESSES) {
            expect(capabilitiesOf("pi", harness.value).runtime).toBe("pi");
        }
    });

    it("sits above the ACP floor: steering, effort and commands are real; terminals and MCP are not", () => {
        const pi = capabilitiesOf("pi", "native");
        expect(pi.steering).toBe(true);
        expect(pi.effort).toBe(true);
        expect(pi.commands).toBe(true);
        const limitations = limitationsOf(pi);
        expect(limitations).toContain("no MCP tools or plugins");
        expect(limitations).toContain("no terminal panel");
        expect(limitations).not.toContain("no mid-turn steering");
        expect(limitations).not.toContain("no effort control");
        expect(limitations).not.toContain("no slash commands");
    });

    it("is an installed capability, so it carries no access requirement to connect", () => {
        expect(accessFor("pi")).toBeUndefined();
    });
});

/* The harness axis is real for exactly two providers, and the three exceptions are each a different shape of
 * "there is nothing to choose". Claude is always its own Claude Code loop. Kimi has no native runtime at all
 * (Moonshot speaks the Anthropic protocol directly), so it runs Claude Code whatever the client sent. Gemini is
 * Kimi's mirror: it has no CLAUDE CODE road, because that loop announces itself in every request and Google's
 * Antigravity channel refuses on the announcement — every account, every time, reported as a spent quota it
 * never was. */
test("only codex and grok change runtime with the harness", () => {
    const switched = PROVIDERS.filter((provider) => capabilitiesOf(provider.value, "native") !== capabilitiesOf(provider.value, "claude-code"));

    expect(switched.map((provider) => provider.value)).toEqual(["codex", "grok"]);
});

/* THE RULE THAT KEEPS CLAUDE CODE TRAFFIC AWAY FROM GOOGLE, asserted where it is decided rather than at each of
 * the surfaces that obey it. Everything downstream — the adapter that serves a turn, the transcript store, the
 * quick helper's choice of loop — reads the runtime off this record, so a Gemini turn asking for Claude Code and
 * getting it back would put the refused loop on the road again everywhere at once. */
test("gemini answers with its own runtime whatever harness is asked for", () => {
    const native = capabilitiesOf("gemini", "native");

    expect(native.runtime).toBe("opencode-gemini");
    expect(capabilitiesOf("gemini", "claude-code")).toEqual(native);
    // Same abilities as the Grok loop it shares — only the runtime id, which keys adapter health, differs.
    expect({ ...native, runtime: "opencode" }).toEqual(capabilitiesOf("grok", "native"));
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
        fastMode: false,
        isolation: "cwd",
        commands: false,
        terminals: false,
        recovery: false,
        instructions: "none",
    };

    // Ten DISCLOSABLE axes, ten sentences: an axis added to the interface without one would silently never be
    // disclosed. fastMode is the deliberate eleventh — a record alone can't tell the truth about it (a
    // translator-routed turn reads true here and still can't go fast), so it is answered by fastAllowed
    // instead. Anything else added to the interface has to move this number.
    expect(limitationsOf(nothing)).toHaveLength(10);
    expect(limitationsOf(nothing).join(" ")).not.toContain("fast");
});

/* The instruction axis has THREE values and only two of them are worth a sentence, which is the one shape the
 * count above cannot check: a middle value that discloses the same words as the floor would tell a Grok user
 * their prompt is ignored when it is in fact being sent. */
test("the instruction axis discloses its two weaker answers, differently", () => {
    const grok = limitationsOf(capabilitiesOf("grok", "native")).join(" ");
    const acp = limitationsOf(capabilitiesOf("some-installed-agent", "native")).join(" ");

    expect(grok).toContain("added to theirs");
    expect(grok).not.toContain("isn't applied");
    expect(acp).toContain("isn't applied");
    // Codex on its own runtime replaces, like the Claude Code loop — so it has nothing to disclose here.
    expect(limitationsOf(capabilitiesOf("codex", "native")).join(" ")).not.toContain("system prompt");
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

/* AN `endpoint/<id>` PROVIDER is a model API the user configured, and the one thing this record has to get right
 * about it is that it is NOT an ACP agent. Both are minted by installing a capability and both are unknown to
 * NATIVE_PROVIDERS, so the id is the only thing that tells them apart — and they want opposite records: an ACP
 * agent brings its own loop and gets the documented floor, while an endpoint is driven BY the Claude Code loop
 * and gets its full ceiling. Getting this backwards would strip steering, per-tool approvals, MCP and the mount
 * namespace from every turn on a user's own model. */
describe("a configured model endpoint", () => {
    it("runs the Claude Code loop at full ceiling, on either harness", () => {
        for (const harness of HARNESSES.map((entry) => entry.value)) {
            expect(capabilitiesOf("endpoint/ollama", harness)).toEqual(capabilitiesOf("claude", harness));
        }
        expect(limitationsOf(capabilitiesOf("endpoint/ollama", "native"))).toEqual([]);
    });

    it("is told apart from an ACP agent by its id alone, so no manifest lookup is needed to read the record", () => {
        expect(capabilitiesOf("goose", "native").runtime).toBe("acp");
        expect(capabilitiesOf("endpoint/goose", "native").runtime).toBe("claude-code");
    });

    it("round-trips its capability id, and carries no access requirement to connect", () => {
        expect(endpointProvider("gpu-box")).toBe("endpoint/gpu-box");
        expect(endpointIdOf(endpointProvider("gpu-box"))).toBe("gpu-box");
        expect(isEndpointProvider("endpoint/gpu-box")).toBe(true);
        // A bare id that merely starts with the word is not one — the separator is what makes the namespace.
        expect(isEndpointProvider("endpoints-r-us")).toBe(false);
        expect(endpointIdOf("claude")).toBeUndefined();
        // Its credential was configured with the endpoint, so there is nothing left for a connect gate to offer.
        expect(accessFor("endpoint/gpu-box")).toBeUndefined();
    });
});

/* FAST SPEED IS OFFERED ON THREE CONDITIONS AT ONCE, and the interesting cases are the ones where two of them
 * hold. A translator-routed provider runs the Claude Code loop — same record, same ceiling — and still cannot go
 * fast, because the harness refuses a non-Anthropic endpoint; a Claude model that publishes no `fast` badge
 * cannot either. Both would be silent failures if the composer offered the control anyway: the turn runs, the
 * answer arrives, and only the bill says it was standard speed. */
describe("offering fast speed", () => {
    it("is offered for a Claude model that publishes the badge", () => {
        expect(fastAllowed(capabilitiesOf("claude", "native"), "claude", ["reasoning", "fast"])).toBe(true);
    });

    it("is refused for a routed provider on the Claude Code loop, whose endpoint is not first-party", () => {
        // Grok under the claude-code harness reads the FULL Claude Code record — the capability alone would say
        // yes. It is served through the sandbox's translator, so the harness would report `not_first_party`.
        expect(capabilitiesOf("grok", "claude-code").fastMode).toBe(true);
        expect(fastAllowed(capabilitiesOf("grok", "claude-code"), "grok", ["fast"])).toBe(false);
        // A user's own model endpoint is the same story for the same reason.
        expect(fastAllowed(capabilitiesOf("endpoint/gpu-box", "native"), "endpoint/gpu-box", ["fast"])).toBe(false);
    });

    it("is refused for a Claude model whose catalog row doesn't publish it", () => {
        expect(fastAllowed(capabilitiesOf("claude", "native"), "claude", ["reasoning"])).toBe(false);
        // The seed floor and any provider that reports ids only — no capabilities published, nothing claimed.
        expect(fastAllowed(capabilitiesOf("claude", "native"), "claude", undefined)).toBe(false);
    });

    it("is refused by every runtime that isn't the Claude Code loop", () => {
        for (const provider of ["codex", "grok"] as const) {
            expect(fastAllowed(capabilitiesOf(provider, "native"), provider, ["fast"])).toBe(false);
        }
        expect(fastAllowed(capabilitiesOf("some-installed-agent", "native"), "some-installed-agent", ["fast"])).toBe(false);
    });
});

/* THE FREE ROW IS THE PRODUCT'S FRONT DOOR, so the list of free providers is derived from the access table and
 * guarded here rather than typed out where it is used. Two things can break it and both are silent: the table
 * losing its last `free` row (the connect gate then has no headline and quietly falls back to pitching a paid
 * subscription to a user who has none), and a `free` row acquiring a requirement that costs money. */
describe("the free providers", () => {
    it("is exactly the access table's free rows, and is never empty", () => {
        expect(FREE_PROVIDERS.length).toBeGreaterThan(0);
        for (const provider of PROVIDERS) {
            const isFree = accessFor(provider.value)?.kind === "free";
            expect(FREE_PROVIDERS.includes(provider.value)).toBe(isFree);
        }
    });

    it("carries the words the connect gate puts on screen", () => {
        // The gate names the provider and states what connecting it runs; a row with either missing would put an
        // empty headline or a dangling sentence in front of the user who has connected nothing.
        for (const provider of FREE_PROVIDERS) {
            const access = accessFor(provider);
            expect(access?.requirement).toBeTruthy();
            expect(access?.runs).toBeTruthy();
        }
    });
});
