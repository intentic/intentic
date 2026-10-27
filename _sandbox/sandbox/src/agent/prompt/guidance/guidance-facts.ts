import type { HostDeviceReach } from "../../../hosts/self-host.js";
import type { OwnBrowserReach } from "../../../webext/webext-peer.js";
import type { OwnPhoneReach } from "../../../phones/phone-peer.js";

/* WHAT A TURN'S GUIDANCE IS COMPOSED FROM, WHICHEVER RUNTIME SERVES IT.

   Every loop takes the same mounts (agent/tools/turn-tools.ts: the browsers, the owner's computers, browsers and phones,
   the daemon's own servers), so every loop is told about them from the same facts. Until 2026-10-25 the paragraphs
   naming a mount reached the Claude Code loop alone and every other runtime got a short remainder: OpenCode and Codex
   turns held three browsers and were told nothing about which one is which, and an ACP agent (Devin) was told nothing at
   all. Two X automations on OpenCode then asked the owner's Brave for x.com while the sandbox's own `x` account sat
   signed in. What still differs between runtimes is only what one genuinely lacks (RuntimeFacts): a tool only the
   Claude Code loop has is named only there, and an MCP tool is spelled the way this runtime lists it. */

// What the runtime serving the turn has of its own, beside the mounts every runtime shares. Facts, not a runtime name:
// an entry asks whether the tool it names exists here, never which loop this is.
export interface RuntimeFacts {
    // Connected tools' schemas wait behind ToolSearch (the Claude Code loop): naming a server says how to load it.
    readonly deferredTools: boolean;
    // The loop's own question card (AskUserQuestion) and plan mode (EnterPlanMode/ExitPlanMode).
    readonly nativeAsk: boolean;
    readonly planMode: boolean;
    // The Task tools the chat draws as this turn's checklist.
    readonly checklist: boolean;
    // Bash takes `run_in_background`, and `wait` and `keep` act on those commands.
    readonly backgroundShell: boolean;
    // A secret reference written in a shell command resolves there (AgentCapabilities.secrets is not "none").
    readonly secretRefs: boolean;
    // What this runtime's tool list puts before `<server>_<tool>` (OpenCode's per-conversation prefix); absent, every
    // MCP tool is spelled `mcp__<server>__<tool>`, as Claude Code, Codex, Cursor and Pi list them.
    readonly toolPrefix?: string | undefined;
}

// The Claude Code loop: every tool of its own, every MCP tool spelled `mcp__<server>__<tool>`. Whether schemas wait
// behind ToolSearch is the turn's own (TurnPolicy.toolSearch): a turn the CLI runs with every tool loaded has no
// ToolSearch at all, and until 2026-10-26 its prompt still said "load them with ToolSearch" seven times. 35 turns in the
// ten days to then called the tool that was not there, and the routed providers this loop also serves (Kimi through the
// translator) never had it either.
export const claudeCodeRuntime = (deferredTools: boolean): RuntimeFacts => ({
    deferredTools,
    nativeAsk: true,
    planMode: true,
    checklist: true,
    backgroundShell: true,
    secretRefs: true,
});

// A Claude Code turn with deferred schemas, as every native Claude turn now runs (settings toolSearch).
export const CLAUDE_CODE_RUNTIME: RuntimeFacts = claudeCodeRuntime(true);

// Any other loop: the shared mounts and nothing of the Claude Code loop's own; whether a secret reference resolves is
// the runtime's own record (AgentCapabilities.secrets).
export const otherRuntime = (secrets: "masked" | "shell" | "none", toolPrefix?: string): RuntimeFacts => {
    const facts: RuntimeFacts = {
        deferredTools: false,
        nativeAsk: false,
        planMode: false,
        checklist: false,
        backgroundShell: false,
        secretRefs: secrets !== "none",
    };
    return toolPrefix === undefined ? facts : { ...facts, toolPrefix };
};

// Everything a turn's guidance is composed from: what its runtime has, what it mounted, and whether anyone is watching.
// Every runtime fills it in from its own mounts (system-prompt.ts promptInputOf for the Claude Code loop,
// guidance/runtime-guidance.ts for every other).
export interface GuidanceFacts {
    readonly runtime: RuntimeFacts;
    readonly unattended: boolean;
    // Set beside a mounted browser server (`web`, `browser`): where its screenshots land.
    readonly browserOutputDir: string | undefined;
    // Whether the credential-free `web` browser is among them; absent reads as mounted, as it was before this fact.
    readonly anonymousBrowser?: boolean;
    // Whether a signed-in account stands behind the routed `browser` server.
    readonly browserAccounts: boolean;
    readonly desktop: boolean;
    readonly diagnostics: boolean;
    // Optional so a caller that predates pages composes the same block it always did.
    readonly pages?: boolean;
    readonly terminal: boolean;
    // The daemon's own servers a turn may lack: the `ui` server's question card, the `watch` server, the `subagents`
    // server's `wait`/`keep`. Absent reads as mounted, which every Claude Code turn is.
    readonly uiAsk?: boolean;
    readonly watch?: boolean;
    readonly subagents?: boolean;
    readonly hostDevices: HostDeviceReach | undefined;
    readonly ownBrowsers: OwnBrowserReach | undefined;
    // Optional so a caller that predates phones composes the same block it always did.
    readonly ownPhones?: OwnPhoneReach | undefined;
}

// One MCP tool as this turn's tool list spells it, in backticks.
export const toolName = ({ runtime }: Pick<GuidanceFacts, "runtime">, server: string, name: string): string =>
    runtime.toolPrefix === undefined ? `\`mcp__${server}__${name}\`` : `\`${runtime.toolPrefix}${server}_${name}\``;

// What every tool of one server starts with in this turn's tool list, in backticks: `mcp__chrome__`, or OpenCode's own.
export const serverPrefix = ({ runtime }: Pick<GuidanceFacts, "runtime">, server: string): string =>
    runtime.toolPrefix === undefined ? `\`mcp__${server}__\`` : `\`${runtime.toolPrefix}${server}_\``;

// How a server's tools are reached before the first call: loaded with ToolSearch where schemas are deferred, already in
// the tool list everywhere else. `hint` is the ToolSearch query; the sentence opens with a space.
export const loadedWith = ({ runtime }: Pick<GuidanceFacts, "runtime">, what: string, hint: string): string =>
    runtime.deferredTools ? ` Load ${what} with ToolSearch (\`${hint}\`).` : ``;

// One server's tools named as this runtime spells them, each in full: a weak model matches names, not patterns.
export const toolsOf = (facts: Pick<GuidanceFacts, "runtime">, server: string, names: readonly string[]): string =>
    names.map((name) => toolName(facts, server, name)).join(", ");
