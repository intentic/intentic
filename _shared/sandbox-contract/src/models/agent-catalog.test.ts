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
    termsOf,
    loopsOf,
    harnessChoosable,
    loopOf,
    canonicalHarness,
    loopLabel,
    loopDoor,
    loopDoors,
    accountServesLoop,
} from "./agent-catalog.js";
import type { AgentCapabilities } from "./agent-runtimes.js";
import { type AgentHarness, type AgentProvider, PermissionModeSchema, withRuntimeDefaults } from "../schemas/agent.js";

// Every provider × harness pair, generated from the catalog itself, must declare what it can do. A failing pair means a
// missing row in capabilitiesOf, never a special case in the caller.

const pairs: { provider: AgentProvider; harness: AgentHarness }[] = PROVIDERS.flatMap((provider) =>
    HARNESSES.map((harness) => ({ provider: provider.value as AgentProvider, harness: harness.value })),
);

describe("every provider/harness pair declares what it can do", () => {
    it.each(pairs)("$provider on the $harness harness", ({ provider, harness }) => {
        const capabilities = capabilitiesOf(provider, harness);

        expect(["claude-code", "codex", "cursor", "opencode", "opencode-gemini", "acp", "devin", "kimi-cli", "grok-build", "pi", "muse"]).toContain(
            capabilities.runtime,
        );
        expect(["modes", "plan"]).toContain(capabilities.permissions);
        expect(["full", "tools", "http", "none"]).toContain(capabilities.mcp);
        expect(capabilities.execution).toContain("shell");
        for (const backend of capabilities.execution) {
            expect(["shell", "js"]).toContain(backend);
        }
        expect(["namespace", "cwd"]).toContain(capabilities.isolation);
        expect(["replace", "append", "none"]).toContain(capabilities.instructions);
        expect(["hooks", "approval", "refuse-only", "none"]).toContain(capabilities.rulebook);
        expect(["masked", "shell", "none"]).toContain(capabilities.secrets);
        // Masking everything the model reads needs a hook in front of every result, which only a hooks-tier loop has;
        // hooks without masking is the one legal direction, so this is an implication, not an equality. The shell-only
        // answer needs no such hook: a wrapper around the command masks what it prints.
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

// The `pi` id is reserved for the Pi coding agent's own RPC runtime: real mid-turn steering, an effort scale, a
// published command list, a process started per turn with the daemon's instructions, skills and namespace, and the
// daemon's own extension in front of every tool, none of which the plain ACP floor carries.
describe("the pi provider", () => {
    it("runs the pi runtime on either harness: pi is its own loop", () => {
        for (const harness of HARNESSES) {
            expect(capabilitiesOf("pi", harness.value).runtime).toBe("pi");
        }
    });

    it("sits above the ACP floor: steering, effort, commands and the terminal panel are real", () => {
        const pi = capabilitiesOf("pi", "native");
        expect(pi.steering).toBe(true);
        expect(pi.effort).toBe(true);
        expect(pi.commands).toBe(true);
        expect(pi.terminals).toBe(true);
        const limitations = limitationsOf(pi);
        expect(limitations.length).toBeGreaterThan(0);
        for (const gone of ["no mid-turn steering", "no effort control", "no slash commands", "no terminal panel"]) {
            expect(limitations).not.toContain(gone);
        }
    });

    // The extension's `tool_call` and `tool_result` hooks, answered on the turn's own socket (runtimes/pi/pi-hooks.ts):
    // the owner's rules and the turn's tool list before a call runs, every result masked after.
    it("holds every call to the owner's rules and the turn's tool list, and masks every result", () => {
        const pi = capabilitiesOf("pi", "native");
        expect(pi.rulebook).toBe("hooks");
        expect(pi.toolAllowlist).toBe(true);
        expect(pi.secrets).toBe("masked");
        const limitations = limitationsOf(pi);
        for (const gone of ["command rules not applied", "secrets reach the model unmasked", "no tool lists: an automation limited to some tools won't run here"]) {
            expect(limitations).not.toContain(gone);
        }
    });

    // Each started with the process (runtimes/pi/pi-rpc.ts): the instruction flags, `--skill` paths with Pi's own
    // discovery off, the ask tool and MCP servers through the daemon's extension, and nsenter into the turn's namespace.
    it("takes the turn's instructions, skills, questions, MCP servers, the daemon's own tools and namespace", () => {
        const pi = capabilitiesOf("pi", "native");
        expect(pi.instructions).toBe("replace");
        expect(pi.skillDiscovery).toBe("native");
        expect(pi.questions).toBe(true);
        expect(pi.mcp).toBe("tools");
        expect(pi.execution).toEqual(["shell", "js"]);
        expect(pi.isolation).toBe("namespace");
        expect(pi.recovery).toBe(true);
        const limitations = limitationsOf(pi);
        for (const gone of ["no clarifying questions", "worktree by cwd only", "no auto-resume after outage", "system prompt not applied"]) {
            expect(limitations).not.toContain(gone);
        }
        expect(limitations).toContain("no plugins");
        expect(limitations).not.toContain("no code runs, shell only");
    });

    it("is an installed capability, so it carries no access requirement to connect", () => {
        expect(accessFor("pi")).toBeUndefined();
    });
});

// Exactly today's provider × loop pairs; a new pair is a row in provider-specs.ts and a line here.
test("each provider offers exactly its loops, its default first", () => {
    expect(Object.fromEntries(PROVIDERS.map((provider) => [provider.value, loopsOf(provider.value)]))).toEqual({
        claude: ["claude-code"],
        codex: ["codex", "claude-code", "opencode"],
        grok: ["opencode", "claude-code", "codex", "vendor"],
        kimi: ["claude-code", "codex", "opencode", "vendor"],
        gemini: ["opencode"],
        cursor: ["vendor"],
        devin: ["vendor"],
        meta: ["muse", "claude-code"],
        zai: ["claude-code", "codex", "opencode"],
    });
    expect(loopsOf("endpoint/ollama")).toEqual(["claude-code", "codex", "opencode", "muse"]);
    // The trial's one model id is the translator's Anthropic route, and its pool cannot replay Muse's tool history: it
    // stays on the loop it discloses itself under.
    expect(loopsOf("endpoint/free-trial")).toEqual(["claude-code"]);
    expect(loopsOf("pi")).toEqual(["pi"]);
    expect(loopsOf("some-installed-agent")).toEqual(["vendor"]);
});

test("every provider with a route a second loop can drive offers a choice of loop", () => {
    expect(PROVIDERS.filter((provider) => harnessChoosable(provider.value)).map((provider) => provider.value)).toEqual(["codex", "grok", "kimi", "meta", "zai"]);
    expect(harnessChoosable("endpoint/ollama")).toBe(true);
    expect(harnessChoosable("endpoint/free-trial")).toBe(false);
    expect(harnessChoosable("some-installed-agent")).toBe(false);
});

describe("resolving a harness to the loop that runs", () => {
    it("reads native as the provider's default loop", () => {
        expect(loopOf("codex", "native")).toBe("codex");
        expect(loopOf("grok", "native")).toBe("opencode");
        expect(loopOf("claude", "native")).toBe("claude-code");
        expect(loopOf("cursor", "native")).toBe("vendor");
    });

    it("keeps an offered loop and runs the default for one the provider lacks", () => {
        expect(loopOf("codex", "claude-code")).toBe("claude-code");
        expect(loopOf("codex", "codex")).toBe("codex");
        expect(loopOf("cursor", "claude-code")).toBe("vendor");
        expect(loopOf("gemini", "claude-code")).toBe("opencode");
        expect(loopOf("claude", "opencode")).toBe("claude-code");
    });

    it("spells a turn naming its default loop the same as one naming none", () => {
        expect(canonicalHarness("codex", "codex")).toBe("native");
        expect(canonicalHarness("codex", undefined)).toBe("native");
        expect(canonicalHarness("codex", "claude-code")).toBe("claude-code");
        expect(canonicalHarness("cursor", "claude-code")).toBe("native");
        // Typed as the wire carries it, not as a literal the intersection in the return type would narrow.
        const stamped = (agent: AgentProvider, harness: AgentHarness): AgentHarness => withRuntimeDefaults({ agent, harness }).harness;
        expect(stamped("grok", "opencode")).toBe("native");
        expect(stamped("grok", "claude-code")).toBe("claude-code");
        expect(stamped("devin", "claude-code")).toBe("native");
    });

    // Only Claude Code turns travel to a runner unasked (runner-scheduler.ts credentialsTravel), and a runner built
    // before the enum widened knows just `native` and `claude-code`: every such turn must be spelled in those.
    it("spells every Claude Code turn in the two values every runner build knows", () => {
        for (const provider of [...PROVIDERS.map((row) => row.value), "endpoint/x", "pi", "some-installed-agent"]) {
            for (const harness of HARNESSES.map((entry) => entry.value)) {
                if (capabilitiesOf(provider, harness).runtime === "claude-code") {
                    expect(["native", "claude-code"], `${provider}/${harness}`).toContain(canonicalHarness(provider, harness));
                }
            }
        }
    });

    it("names each loop, the provider's own agent by the provider", () => {
        expect(loopsOf("codex").map((loop) => loopLabel("codex", loop))).toEqual(["Codex", "Claude Code", "OpenCode"]);
        expect(loopLabel("grok", "opencode")).toBe("OpenCode");
        expect(loopLabel("cursor", "vendor")).toBe("Cursor");
        expect(loopLabel("meta", "muse")).toBe("Muse Code");
    });
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

// Made up rather than borrowed: real runtimes gain modes as their seams are wired, and a test pinned to one stops testing
// the plan-only answer the day it does.
const PLAN_ONLY: AgentCapabilities = { ...capabilitiesOf("claude", "native"), permissions: "plan" };

test("a plan-only runtime offers the two postures it has", () => {
    expect(modesFor(PLAN_ONLY)).toEqual(["plan", "bypassPermissions"]);
    expect(modesFor(capabilitiesOf("claude", "native"))).toEqual(["default", "plan", "bypassPermissions"]);
    // Codex answers its own approval requests per mode, so it offers the ask-each-tool posture too.
    expect(modesFor(capabilitiesOf("codex", "native"))).toEqual(["default", "plan", "bypassPermissions"]);
});

test("a mode the runtime can't hold falls back to the one it runs; one it can holds", () => {
    expect(clampMode("default", PLAN_ONLY)).toBe("bypassPermissions");
    expect(clampMode("plan", PLAN_ONLY)).toBe("plan");
    expect(clampMode("default", capabilitiesOf("claude", "native"))).toBe("default");
    expect(clampMode("default", capabilitiesOf("codex", "native"))).toBe("default");
});

test("the ceiling has nothing to disclose; a floor names what it lacks", () => {
    expect(limitationsOf(capabilitiesOf("claude", "native"))).toEqual([]);

    const grokCaps = capabilitiesOf("grok", "native");
    // OpenCode 2's session API carries steers, per-tool asks, forms, variants, commands and typed failures, the daemon runs
    // its shell (terminal pane, secrets) and serves it the daemon's own tools over the door, and its session rules keep a
    // tool list; what Grok still lacks is the namespace, plugins and masking beyond the shell.
    expect(grokCaps.permissions).toBe("modes");
    expect(grokCaps.steering).toBe(true);
    expect(grokCaps.questions).toBe(true);
    expect(grokCaps.effort).toBe(true);
    expect(grokCaps.commands).toBe(true);
    expect(grokCaps.recovery).toBe(true);
    expect(grokCaps.isolation).toBe("cwd");
    expect(grokCaps.terminals).toBe(true);
    expect(grokCaps.toolAllowlist).toBe(true);
    expect(grokCaps.execution).toEqual(["shell", "js"]);
    expect(limitationsOf(grokCaps).length).toBeGreaterThan(0);
    expect(limitationsOf(grokCaps)).not.toContain("no mid-turn steering");
    expect(limitationsOf(grokCaps)).not.toContain("no per-tool approvals");
    expect(limitationsOf(grokCaps)).not.toContain("no auto-resume after outage");
    // The turn's remote servers and the daemon's own, through the door, mounted on the shared OpenCode server per
    // conversation.
    expect(grokCaps.mcp).toBe("tools");
    expect(limitationsOf(grokCaps)).toContain("no plugins");
    expect(limitationsOf(grokCaps)).toEqual(
        expect.not.arrayContaining(["no terminal panel", "no code runs, shell only", "no tool lists: an automation limited to some tools won't run here"]),
    );

    // The daemon's own servers reach every ACP agent through the door, over http or the daemon's stdio proxy.
    const acpCaps = capabilitiesOf("some-installed-agent", "native");
    expect(acpCaps.mcp).toBe("tools");
    expect(acpCaps.execution).toEqual(["shell", "js"]);
    const acp = limitationsOf(acpCaps);
    expect(acp).toContain("no plugins");
    expect(acp).not.toContain("no code runs, shell only");
    expect(acpCaps.commands).toBe(true);
    expect(acpCaps.terminals).toBe(true);
    // Per-tool approvals and questions ride the protocol's own seams (request_permission, form elicitation); effort,
    // isolation and recovery stay off, since the record is every agent's and the pooled process is every conversation's.
    expect(acpCaps.permissions).toBe("modes");
    expect(acpCaps.questions).toBe(true);
    expect(acp).not.toContain("no per-tool approvals");
    expect(acp).not.toContain("no clarifying questions");
    expect(acp).toEqual(expect.arrayContaining(["no effort control", "worktree by cwd only", "no auto-resume after outage"]));

    // Codex takes the daemon's own servers too, over the door, so only plugins are missing.
    const codexCaps = capabilitiesOf("codex", "native");
    expect(codexCaps.mcp).toBe("tools");
    expect(limitationsOf(codexCaps)).toContain("no plugins");
    expect(limitationsOf(codexCaps)).not.toContain("MCP servers only, none of the daemon's own tools, no plugins");
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
        warm: false,
        instructions: "none",
        skillDiscovery: "prompt",
        rulebook: "none",
        secrets: "none",
        privacy: "none",
        toolAllowlist: false,
    };

    // Fourteen disclosable axes, fourteen sentences; `fastMode` is disclosed via fastAllowed, and `warm` (keep-warm, off by
    // default) is no limit on the turn itself.
    expect(limitationsOf(nothing)).toHaveLength(14);
    expect(limitationsOf(nothing).join(" ")).not.toContain("fast");
});

test("the safety axes disclose the middle answer differently from the floor", () => {
    const claudeCaps = capabilitiesOf("claude", "native");
    const codexCaps = capabilitiesOf("codex", "native");
    const piCaps = capabilitiesOf("pi", "native");
    const grokCaps = capabilitiesOf("grok", "native");

    expect(claudeCaps.rulebook).toBe("hooks");
    expect(claudeCaps.secrets).toBe("masked");

    // Codex's own per-thread hooks put every call to the gate before it runs, so its rules hold any call, as Claude's do.
    expect(codexCaps.rulebook).toBe("hooks");
    expect(limitationsOf(codexCaps).join(" ")).not.toContain("command rules");
    // Pi's own extension puts every call to the gate before it runs and masks every result after (runtimes/pi/pi-hooks.ts).
    expect(piCaps.rulebook).toBe("hooks");
    expect(piCaps.secrets).toBe("masked");
    expect(grokCaps.rulebook).toBe("approval");
    // A hold parks on a card now that the turn's watchdog is held while it waits, so nothing says it cannot hold.
    expect(limitationsOf(grokCaps)).toContain("command rules apply only to calls this agent raises");
    expect(limitationsOf(grokCaps)).not.toContain("command rules can refuse but not hold");

    expect(limitationsOf(claudeCaps).join(" ")).not.toContain("command rules");
    expect(limitationsOf(claudeCaps).join(" ")).not.toContain("stored secrets");

    expect(limitationsOf(codexCaps).length).toBeGreaterThan(limitationsOf(claudeCaps).length);
    expect(limitationsOf(piCaps).length).toBeGreaterThan(limitationsOf(claudeCaps).length);
    expect(limitationsOf(piCaps).join(" ")).not.toContain("command rules");
    expect(limitationsOf(grokCaps).join(" ")).toBe(limitationsOf(capabilitiesOf("gemini", "native")).join(" "));

    // The middle answer: references resolved and output masked in the shell, but not in what the loop's own file tools read.
    // Codex masks through its hooks' wrapper, OpenCode through the daemon's shell script.
    for (const caps of [codexCaps, grokCaps]) {
        expect(caps.secrets).toBe("shell");
        expect(limitationsOf(caps)).toContain("secrets masked in shell output only, not in files the agent reads");
        expect(limitationsOf(caps)).not.toContain("secrets reach the model unmasked");
    }

    for (const provider of ["devin", "some-installed-agent"] as const) {
        expect(capabilitiesOf(provider, "native").secrets).toBe("none");
    }
});

// Cursor's shell runs through the daemon's hook script, which resolves a reference and masks what a command prints; its
// read tool can only be refused, so the picker says the masking stops at the shell rather than claiming the ceiling's.
test("secrets on Cursor's runtime are disclosed as reaching the shell only", () => {
    const cursorCaps = capabilitiesOf("cursor", "native");
    expect(cursorCaps.secrets).toBe("shell");
    const limitations = limitationsOf(cursorCaps);
    expect(limitations).toContain("secrets masked in shell output only, not in files the agent reads");
    expect(limitations).not.toContain("secrets reach the model unmasked");
});

test("the instruction axis discloses its two weaker answers, differently", () => {
    // No runtime appends any more (each found a seam to replace the base), so the append answer is made up.
    const appending: AgentCapabilities = { ...capabilitiesOf("claude", "native"), instructions: "append" };
    const acpCaps = capabilitiesOf("some-installed-agent", "native");
    const codexCaps = capabilitiesOf("codex", "native");

    expect(acpCaps.instructions).toBe("none");
    expect(codexCaps.instructions).toBe("replace");
    // Grok's owner prompt runs on OpenCode's blank-base agents, so it replaces the base as Codex's does.
    expect(capabilitiesOf("grok", "native").instructions).toBe("replace");

    expect(limitationsOf(appending)).toEqual(["system prompt appended, not replaced"]);
    expect(limitationsOf(acpCaps)).toContain("system prompt not applied");
    expect(limitationsOf(codexCaps).join(" ")).not.toContain("system prompt");
});

// The backend is one of the daemon's own functions, so it takes a runtime that can call one AND a gate the daemon
// controls: Claude Code has the SDK server plus its PreToolUse matcher, Cursor has customTools plus a consult inside the
// handler, and Codex, OpenCode (Grok, Gemini), an ACP agent, Devin, the Kimi and Grok CLIs, Pi and Muse reach the door's
// `code` server, whose every script is consulted against the gate its loop attaches to the turn's relay. Every other
// runtime is a child process with neither, where a script would run unread.
test("the js execution backend rides the runtimes that can host the daemon's own tools", () => {
    const hosts: ReadonlySet<string> = new Set([
        "claude-code",
        "cursor",
        "codex",
        "opencode",
        "opencode-gemini",
        "acp",
        "devin",
        "kimi-cli",
        "grok-build",
        "pi",
        "muse",
    ]);
    for (const { provider, harness } of pairs) {
        const capabilities = capabilitiesOf(provider, harness);
        expect(capabilities.execution.includes("js")).toBe(hosts.has(capabilities.runtime));
    }
});

test("the Claude Code loop offers every PermissionMode the wire has", () => {
    // Read off the schema, not retyped: the claim is that the runtime holds whatever the wire can carry.
    const wire = PermissionModeSchema.options;

    expect([...modesFor(capabilitiesOf("claude", "native"))].toSorted()).toEqual([...wire].toSorted());
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

// An `endpoint/<id>` provider is a user's own model API, told apart from an ACP agent only by its id: by default it runs
// the Claude Code loop at full ceiling, never the ACP floor, and Codex and OpenCode as the owner picks them.
describe("a configured model endpoint", () => {
    it("runs the Claude Code loop at full ceiling by default, and Codex, OpenCode or Muse Code where asked", () => {
        for (const harness of HARNESSES.map((entry) => entry.value)) {
            const hosted =
                harness === "codex" || harness === "opencode"
                    ? capabilitiesOf("grok", harness)
                    : harness === "muse"
                      ? capabilitiesOf("meta", "muse")
                      : capabilitiesOf("claude", harness);
            expect(capabilitiesOf("endpoint/ollama", harness), harness).toEqual(hosted);
        }
        expect(limitationsOf(capabilitiesOf("endpoint/ollama", "native"))).toEqual([]);
        expect(capabilitiesOf("endpoint/ollama", "muse").runtime).toBe("muse");
        expect(capabilitiesOf("endpoint/free-trial", "muse").runtime).toBe("claude-code");
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

// Fast speed needs every condition at once; a translator-routed provider or a Claude model with no `fast` badge
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

    // Codex asks its own vendor for the tier its own catalog published, so there is no route to second-guess.
    it("is offered by Codex for a model that publishes the badge, and only for one", () => {
        expect(fastAllowed(capabilitiesOf("codex", "native"), "codex", ["fast"])).toBe(true);
        expect(fastAllowed(capabilitiesOf("codex", "native"), "codex", undefined)).toBe(false);
    });

    it("is refused by every runtime that cannot ask for it", () => {
        expect(fastAllowed(capabilitiesOf("grok", "native"), "grok", ["fast"])).toBe(false);
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

// A vendor's own terms ride beside the loop they speak to, said quietly (an icon's hover card). Resolved as the turn is:
// a loop the provider does not offer reads as the one it runs, so the note follows what actually runs.
describe("the vendor's terms for a loop", () => {
    it("marks the routes a vendor forbids, whichever loop is asked for", () => {
        expect(termsOf("gemini", "native")?.status).toBe("against-terms");
        expect(termsOf("gemini", "claude-code")).toEqual(termsOf("gemini", "native"));
        expect(termsOf("meta", "claude-code")?.status).toBe("against-terms");
    });

    it("says nothing for Meta's key in Muse Code, the use Meta's terms sanction", () => {
        expect(termsOf("meta", "native")).toBeUndefined();
        expect(termsOf("meta", "muse")).toBeUndefined();
        expect(termsOf("endpoint/local", "muse")).toBeUndefined();
    });

    it("marks a loop the vendor does not list, and only that loop", () => {
        expect(termsOf("codex", "claude-code")?.status).toBe("unlisted");
        expect(termsOf("codex", "native")).toBeUndefined();
        expect(termsOf("grok", "claude-code")?.status).toBe("unlisted");
        expect(termsOf("grok", "native")).toBeUndefined();
    });

    it("says nothing where the vendor sanctions the loop, or for a provider it knows nothing about", () => {
        for (const provider of ["claude", "kimi", "zai", "cursor", "devin", "endpoint/local", "some-installed-agent"]) {
            expect(termsOf(provider, "native"), provider).toBeUndefined();
        }
    });

    it("always says where the vendor says it", () => {
        for (const provider of PROVIDERS) {
            for (const harness of HARNESSES) {
                const terms = termsOf(provider.value, harness.value);
                if (terms !== undefined) {
                    expect(terms.source).toMatch(/^https:\/\//);
                    expect(terms.note).toMatch(/\S/);
                }
            }
        }
    });
});

// A vendor CLI's loop names the program, since the provider's own name is on its other loops too; every other loop keeps
// its own name, and an installed agent's `vendor` loop is still the agent's.
test("the vendor loop of Grok and Kimi is named for the CLI that runs it", () => {
    expect(loopLabel("grok", "vendor")).toBe("Grok Build");
    expect(loopLabel("kimi", "vendor")).toBe("Kimi CLI");
    expect(loopLabel("grok", "opencode")).toBe("OpenCode");
    expect(loopLabel("devin", "vendor")).toBe("Devin");
});

// The CLI loops sign in through a door variant of their own; the other loops spend the provider's default credential, so
// one account list serves both and the variant says which loop a row belongs to.
test("an account serves the loop whose door its variant names", () => {
    expect(loopDoor("grok", "vendor")).toBe("grok-build");
    expect(loopDoor("grok", "native")).toBeUndefined();
    expect(loopDoors("kimi")).toEqual([{ loop: "vendor", door: "kimi-cli" }]);
    expect(accountServesLoop("grok", "vendor", { variant: "grok-build" })).toBe(true);
    expect(accountServesLoop("grok", "native", { variant: "grok-build" })).toBe(false);
    expect(accountServesLoop("grok", "opencode", {})).toBe(true);
    expect(accountServesLoop("grok", "vendor", {})).toBe(false);
    // Z.ai's variants are estates, not doors: every account serves its one loop.
    expect(accountServesLoop("zai", "native", { variant: "bigmodel" })).toBe(true);
});
