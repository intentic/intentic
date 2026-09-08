import { describe, expect, it, test } from "vitest";
import {
    accessFor,
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
    sendableThinking,
} from "./agent-catalog.js";
import type { AgentCapabilities } from "./agent-runtimes.js";
import type { AgentHarness, AgentProvider, PermissionMode } from "../schemas/agent.js";

// Every provider × harness pair, generated from the catalog itself, must declare what it can do. A failing pair means a
// missing row in capabilitiesOf, never a special case in the caller.

const pairs: { provider: AgentProvider; harness: AgentHarness }[] = PROVIDERS.flatMap((provider) =>
    HARNESSES.map((harness) => ({ provider: provider.value as AgentProvider, harness: harness.value })),
);

describe("every provider/harness pair declares what it can do", () => {
    it.each(pairs)("$provider on the $harness harness", ({ provider, harness }) => {
        const capabilities = capabilitiesOf(provider, harness);

        expect(["claude-code", "codex", "cursor", "opencode", "opencode-gemini", "acp", "pi"]).toContain(capabilities.runtime);
        expect(["modes", "plan"]).toContain(capabilities.permissions);
        expect(["full", "tools", "browser", "http", "none"]).toContain(capabilities.mcp);
        expect(capabilities.execution).toContain("shell");
        for (const backend of capabilities.execution) {
            expect(["shell", "js"]).toContain(backend);
        }
        expect(["namespace", "cwd"]).toContain(capabilities.isolation);
        expect(["replace", "append", "none"]).toContain(capabilities.instructions);
        expect(["hooks", "approval", "refuse-only", "none"]).toContain(capabilities.rulebook);
        expect(["masked", "none"]).toContain(capabilities.secrets);
        // Masking is a PostToolUse hook and nothing else can edit what a model reads; hooks without masking is the one
        // legal direction, so this is an implication, not an equality.
        if (capabilities.secrets === "masked") {
            expect(capabilities.rulebook).toBe("hooks");
        }
        // The modes offered must include the mode a clamp falls back to, or the composer could show a posture the
        // runtime can't hold.
        expect(modesFor(capabilities)).toContain(clampMode("default", capabilities));
    });
});

test("an unknown provider id is an ACP agent, on either harness", () => {
    for (const harness of HARNESSES) {
        expect(capabilitiesOf("some-installed-agent", harness.value).runtime).toBe("acp");
    }
});

// The `pi` id is reserved for the Pi coding agent's own RPC runtime: real mid-turn steering, an effort scale and a
// published command list, none of which the plain ACP floor carries.
describe("the pi provider", () => {
    it("runs the pi runtime on either harness: pi is its own loop", () => {
        for (const harness of HARNESSES) {
            expect(capabilitiesOf("pi", harness.value).runtime).toBe("pi");
        }
    });

    it("sits above the ACP floor: steering, effort and commands are real; terminals and MCP are not", () => {
        const pi = capabilitiesOf("pi", "native");
        expect(pi.steering).toBe(true);
        expect(pi.effort).toBe(true);
        expect(pi.commands).toBe(true);
        expect(pi.mcp).toBe("none");
        expect(pi.terminals).toBe(false);
        const limitations = limitationsOf(pi);
        expect(limitations.length).toBeGreaterThan(0);
        expect(limitations).not.toContain("no mid-turn steering");
        expect(limitations).not.toContain("no effort control");
        expect(limitations).not.toContain("no slash commands");
    });

    it("is an installed capability, so it carries no access requirement to connect", () => {
        expect(accessFor("pi")).toBeUndefined();
    });
});

test("only codex and grok change runtime with the harness", () => {
    const switched = PROVIDERS.filter((provider) => capabilitiesOf(provider.value, "native") !== capabilitiesOf(provider.value, "claude-code"));

    expect(switched.map((provider) => provider.value)).toEqual(["codex", "grok"]);
});

test("gemini answers with its own runtime whatever harness is asked for", () => {
    const native = capabilitiesOf("gemini", "native");

    expect(native.runtime).toBe("opencode-gemini");
    expect(capabilitiesOf("gemini", "claude-code")).toEqual(native);
    expect({ ...native, runtime: "opencode" }).toEqual(capabilitiesOf("grok", "native"));
});

test("codex and grok under the Claude Code harness get the full ceiling, it is the same loop", () => {
    for (const provider of ["codex", "grok"] as const) {
        expect(capabilitiesOf(provider, "claude-code")).toEqual(capabilitiesOf("claude", "native"));
    }
});

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

test("the ceiling has nothing to disclose; a floor names what it lacks", () => {
    expect(limitationsOf(capabilitiesOf("claude", "native"))).toEqual([]);

    const grokCaps = capabilitiesOf("grok", "native");
    expect(grokCaps.permissions).toBe("plan");
    expect(grokCaps.steering).toBe(false);
    expect(grokCaps.isolation).toBe("cwd");
    expect(limitationsOf(grokCaps).length).toBeGreaterThan(0);

    const acpCaps = capabilitiesOf("some-installed-agent", "native");
    expect(acpCaps.mcp).toBe("http");
    const acp = limitationsOf(acpCaps);
    expect(acp.some((line) => line.includes("MCP"))).toBe(true);
    expect(acpCaps.commands).toBe(true);
    expect(acpCaps.terminals).toBe(true);

    const codexCaps = capabilitiesOf("codex", "native");
    expect(codexCaps.mcp).toBe("browser");
    expect(limitationsOf(codexCaps).some((line) => line.includes("browser"))).toBe(true);
    expect(limitationsOf(codexCaps).length).toBeLessThan(limitationsOf({ ...grokCaps, mcp: "none" }).length + 5);
});

test("every axis a record can lack has words for it", () => {
    const nothing: AgentCapabilities = {
        runtime: "acp",
        steering: false,
        permissions: "plan",
        questions: false,
        mcp: "none",
        execution: ["shell"],
        effort: false,
        fastMode: false,
        isolation: "cwd",
        commands: false,
        terminals: false,
        recovery: false,
        instructions: "none",
        skillDiscovery: "prompt",
        rulebook: "none",
        secrets: "none",
    };

    // Thirteen disclosable axes, thirteen sentences; `fastMode` is the exception, disclosed via fastAllowed.
    expect(limitationsOf(nothing)).toHaveLength(13);
    expect(limitationsOf(nothing).join(" ")).not.toContain("fast");
});

test("the safety axes disclose the middle answer differently from the floor", () => {
    const claudeCaps = capabilitiesOf("claude", "native");
    const codexCaps = capabilitiesOf("codex", "native");
    const piCaps = capabilitiesOf("pi", "native");
    const grokCaps = capabilitiesOf("grok", "native");

    expect(claudeCaps.rulebook).toBe("hooks");
    expect(claudeCaps.secrets).toBe("masked");

    expect(codexCaps.rulebook).toBe("approval");
    expect(piCaps.rulebook).toBe("none");
    expect(grokCaps.rulebook).toBe("refuse-only");

    expect(limitationsOf(claudeCaps).join(" ")).not.toContain("command rules");
    expect(limitationsOf(claudeCaps).join(" ")).not.toContain("stored secrets");

    expect(limitationsOf(codexCaps).length).toBeGreaterThan(limitationsOf(claudeCaps).length);
    expect(limitationsOf(piCaps).length).toBeGreaterThan(limitationsOf(claudeCaps).length);
    expect(limitationsOf(grokCaps).join(" ")).toBe(limitationsOf(capabilitiesOf("gemini", "native")).join(" "));

    for (const provider of ["codex", "grok", "gemini", "pi", "some-installed-agent"] as const) {
        expect(capabilitiesOf(provider, "native").secrets).toBe("none");
    }
});

test("the instruction axis discloses its two weaker answers, differently", () => {
    const grokCaps = capabilitiesOf("grok", "native");
    const acpCaps = capabilitiesOf("some-installed-agent", "native");
    const codexCaps = capabilitiesOf("codex", "native");

    expect(grokCaps.instructions).toBe("append");
    expect(acpCaps.instructions).toBe("none");
    expect(codexCaps.instructions).toBe("replace");

    expect(limitationsOf(grokCaps).length).toBeGreaterThan(limitationsOf(codexCaps).length);
    expect(limitationsOf(acpCaps).length).toBeGreaterThan(limitationsOf(codexCaps).length);
});

test("only the Claude Code loop hosts the js execution backend", () => {
    for (const { provider, harness } of pairs) {
        const capabilities = capabilitiesOf(provider, harness);
        expect(capabilities.execution.includes("js")).toBe(capabilities.runtime === "claude-code");
    }
});

test("the Claude Code loop offers every PermissionMode the wire has", () => {
    const wire: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

    expect([...modesFor(capabilitiesOf("claude", "native"))].toSorted()).toEqual(wire.toSorted());
});

// `effortAllowed` is not a claim about who has the max tier: the picker isn't the only assembler of a turn, so the rule
// is checked wherever one is built, not just there.
describe("the max-effort rule", () => {
    it("takes the top rung from one pair only: Claude with extended thinking switched off", () => {
        expect(effortAllowed("max", "claude", true)).toBe(true);
        expect(effortAllowed("max", "claude", false)).toBe(false);
        expect(effortAllowed("max", "claude", undefined)).toBe(true);
        expect(effortAllowed("max", "kimi", false)).toBe(true);
        expect(effortAllowed("high", "kimi", false)).toBe(true);
    });

    it("is repaired, not refused, on the way to the API: the tier drops, the user's thinking choice does not", () => {
        expect(sendableEffort("max", false)).toBe("high");
        expect(sendableEffort("max", true)).toBe("max");
        expect(sendableEffort("max", undefined)).toBe("max");
        expect(sendableEffort("high", false)).toBe("high");
        expect(sendableEffort(undefined, false)).toBeUndefined();
    });

    it("names the reasoning a max turn needs where the run pinned none, and overrides nothing that was pinned", () => {
        expect(sendableThinking("max", undefined)).toBe(true);
        expect(sendableThinking("max", false)).toBe(false);
        expect(sendableThinking("max", true)).toBe(true);
        expect(sendableThinking("xhigh", undefined)).toBeUndefined();
        expect(sendableThinking(undefined, undefined)).toBeUndefined();
    });
});

// An `endpoint/<id>` provider is a user's own model API, told apart from an ACP agent only by its id: it runs the
// Claude Code loop at full ceiling, never the ACP floor.
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
        expect(isEndpointProvider("endpoints-r-us")).toBe(false);
        expect(endpointIdOf("claude")).toBeUndefined();
        expect(accessFor("endpoint/gpu-box")).toBeUndefined();
    });
});

// Fast speed needs all three conditions at once; a translator-routed provider or a Claude model with no `fast` badge
// fails silently otherwise: the turn runs at standard speed and only the bill shows it.
describe("offering fast speed", () => {
    it("is offered for a Claude model that publishes the badge", () => {
        expect(fastAllowed(capabilitiesOf("claude", "native"), "claude", ["reasoning", "fast"])).toBe(true);
    });

    it("is refused for a routed provider on the Claude Code loop, whose endpoint is not first-party", () => {
        expect(capabilitiesOf("grok", "claude-code").fastMode).toBe(true);
        expect(fastAllowed(capabilitiesOf("grok", "claude-code"), "grok", ["fast"])).toBe(false);
        expect(fastAllowed(capabilitiesOf("endpoint/gpu-box", "native"), "endpoint/gpu-box", ["fast"])).toBe(false);
    });

    it("is refused for a Claude model whose catalog row doesn't publish it", () => {
        expect(fastAllowed(capabilitiesOf("claude", "native"), "claude", ["reasoning"])).toBe(false);
        expect(fastAllowed(capabilitiesOf("claude", "native"), "claude", undefined)).toBe(false);
    });

    it("is refused by every runtime that isn't the Claude Code loop", () => {
        for (const provider of ["codex", "grok"] as const) {
            expect(fastAllowed(capabilitiesOf(provider, "native"), provider, ["fast"])).toBe(false);
        }
        expect(fastAllowed(capabilitiesOf("some-installed-agent", "native"), "some-installed-agent", ["fast"])).toBe(false);
    });
});

// The free-provider list is derived from the access table, not hand-typed, so a lost `free` row or one gaining a cost
// silently breaks the connect gate's headline.
describe("the free providers", () => {
    it("is exactly the access table's free rows, and is never empty", () => {
        expect(FREE_PROVIDERS.length).toBeGreaterThan(0);
        for (const provider of PROVIDERS) {
            const isFree = accessFor(provider.value)?.kind === "free";
            expect(FREE_PROVIDERS.includes(provider.value)).toBe(isFree);
        }
    });

    it("carries the words the connect gate puts on screen", () => {
        for (const provider of FREE_PROVIDERS) {
            const access = accessFor(provider);
            expect(access?.requirement).toEqual(expect.stringMatching(/\S/));
            expect(access?.runs).toEqual(expect.stringMatching(/\S/));
        }
    });
});
