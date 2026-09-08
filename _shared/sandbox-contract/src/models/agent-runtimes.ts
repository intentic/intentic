// What each agentic loop can do, one record per runtime, nothing about which provider runs on it. A capability is
// listed only if something reads it: a gate, a control, or limitationsOf. This file is the bottom of the provider graph
// and imports nothing from the rest of the contract, so the arrow points one way.

// An execution backend: one way a turn runs its own work, named for AgentCapabilities.execution and the persona switch
// that grants it.
export type ExecutionBackend = "shell" | "js";

export interface AgentCapabilities {
    // Which loop serves the turn; `opencode-gemini` stays separate since adapter health keys off this field.
    readonly runtime: "claude-code" | "codex" | "opencode" | "opencode-gemini" | "acp" | "pi" | "cursor";
    // Mid-turn injection (the SteeringQueue behind /agent/steer); needs the SDK's streaming-input mode.
    readonly steering: boolean;
    // How much of the permission-mode axis the runtime honours: every PermissionMode, or just propose-then-approve.
    readonly permissions: "modes" | "plan";
    // Can stop mid-turn and ask the user a multiple-choice question (`question` frames).
    readonly questions: boolean;
    // Which tools reach the agent, full down to none; never rounded up or down from what a runtime has.
    readonly mcp: "full" | "tools" | "browser" | "http" | "none";
    // Which ways of executing the daemon stands behind here; distinct from `mcp`, which names tools, not execution.
    readonly execution: readonly ExecutionBackend[];
    // Reasoning-effort selection is forwarded to the model.
    readonly effort: boolean;
    // Whether the loop can ask for fast speed; the route's own answer is decided separately, at the endpoint.
    readonly fastMode: boolean;
    // How an isolated turn's worktree is enforced: a mount namespace, or merely cwd'd in, /work still shared.
    readonly isolation: "namespace" | "cwd";
    // Publishes its slash commands (`commands` frames) for the composer's `/` popover.
    readonly commands: boolean;
    // Runs its shell in a tmux session the terminal panel can attach to (`terminal` frames).
    readonly terminals: boolean;
    // Fails with the coded frames auto-resume keys off, so a turn the provider killed is re-run once it's back.
    readonly recovery: boolean;
    // How much of the owner's instructions this runtime takes: replace the base, append to it, or no seam at all.
    readonly instructions: "replace" | "append" | "none";
    // How the runtime discovers loaded skills: scans its own filesystem, or the daemon names them in the opener.
    readonly skillDiscovery: "native" | "prompt";
    // Whether the owner's safety policy reaches this runtime, and how:
    // hooks - its own pre-execution hook can park a call and wait for a card (Claude Code only).
    // approval - a vendor approval channel the daemon answers from policy; the vendor picks which calls to raise.
    // refuse-only - the same channel, but a clock forces a refusal instead of a park.
    // none - no seam before a command runs; treated as tainted, never as clean.
    readonly rulebook: "hooks" | "approval" | "refuse-only" | "none";
    // Whether a credential is masked; "none" is structural, only the Claude Code loop can rewrite a model's read.
    readonly secrets: "masked" | "none";
}

// The Claude Code Agent SDK loop, the ceiling every other runtime is measured against: the only one that owns the whole
// request (permission callbacks, the ask tool, plugins, hooks, the mount-namespace spawn seam).
export const CLAUDE_CODE: AgentCapabilities = {
    runtime: "claude-code",
    steering: true,
    permissions: "modes",
    questions: true,
    mcp: "full",
    // The one loop with a seam for the daemon's own backend, so it hosts JS beside its Bash.
    execution: ["shell", "js"],
    effort: true,
    fastMode: true,
    isolation: "namespace",
    commands: true,
    terminals: true,
    recovery: true,
    instructions: "replace",
    skillDiscovery: "native",
    // The only runtime with its own pre-execution hook, so the only one where a hold can park instead of refusing.
    rulebook: "hooks",
    secrets: "masked",
};

// Codex app-server: item-level events, process-backed MCP, and four seams (steer, a question request, the skills list,
// the shared mount namespace). Daemon-side servers, plugins, server approvals stay unwired.
export const CODEX: AgentCapabilities = {
    runtime: "codex",
    steering: true,
    permissions: "plan",
    questions: true,
    mcp: "browser",
    execution: ["shell"],
    effort: true,
    fastMode: false,
    isolation: "namespace",
    commands: true,
    terminals: false,
    recovery: false,
    // Both ride the per-thread config: one replaces Codex's base prompt, the other adds a developer message.
    instructions: "replace",
    skillDiscovery: "native",
    // Asked only when the owner has written command rules; an unconfigured workspace pays nothing for it.
    rulebook: "approval",
    secrets: "none",
};

// OpenCode (the Grok runtime): its own agentic loop, its own tools, allow-all permissions. Takes a model id, a prompt
// and one system message of ours; no effort scale, no tools of ours, no command list.
export const OPENCODE: AgentCapabilities = {
    runtime: "opencode",
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
    // `system` on the prompt body, per message; adds to OpenCode's own prompt, with no seam to replace it.
    instructions: "append",
    skillDiscovery: "prompt",
    // refuse-only for its inactivity watchdog, not its protocol: a paused approval reads as a stalled turn.
    rulebook: "refuse-only",
    secrets: "none",
};

// The same OpenCode loop, serving Gemini instead of xAI, identical abilities. The Claude Code loop announces itself in
// every request, which Google's Antigravity channel refuses; this loop's prompt makes no such announcement.
export const OPENCODE_GEMINI: AgentCapabilities = {
    ...OPENCODE,
    runtime: "opencode-gemini",
};

// Any agent speaking the Agent Client Protocol: a documented floor, not the native ceiling. Publishes commands and
// terminals, takes http MCP tools when offered, but owns its own model, effort and permission posture.
export const ACP: AgentCapabilities = {
    runtime: "acp",
    steering: false,
    permissions: "plan",
    questions: false,
    mcp: "http",
    execution: ["shell"],
    effort: false,
    fastMode: false,
    isolation: "cwd",
    commands: true,
    terminals: true,
    recovery: false,
    // ACP's calls carry no system field: the agent owns its instructions, the persona note rides the message.
    instructions: "none",
    skillDiscovery: "prompt",
    // In the protocol floor, so every agent has it; which calls it asks about is entirely its own choice.
    rulebook: "approval",
    secrets: "none",
};

// Pi driven over its RPC mode: above the ACP floor and below the Claude Code ceiling. Real mid-turn steering, an effort
// scale, and a published command list; no MCP seam, no approval channel, bash runs in-process with no terminal session.
export const PI: AgentCapabilities = {
    runtime: "pi",
    steering: true,
    permissions: "plan",
    questions: false,
    mcp: "none",
    execution: ["shell"],
    effort: true,
    fastMode: false,
    isolation: "cwd",
    commands: true,
    terminals: false,
    recovery: false,
    // Pi's RPC sets no standing instructions; like ACP, it hears the persona note through the user message.
    instructions: "none",
    skillDiscovery: "prompt",
    // The one runtime with no seam at all: bash runs in-process, and no rule the owner writes can apply.
    rulebook: "none",
    secrets: "none",
};

// Cursor's own runtime, driven through `@cursor/sdk` in this daemon's process; an embedding surface, so most seams
// other runtimes lack are function arguments here. The harness axis doesn't apply: the SDK is the only door.
export const CURSOR: AgentCapabilities = {
    runtime: "cursor",
    // The SDK's Run can be cancelled but not written to mid-flight; a second send errors rather than injecting.
    steering: false,
    // Cursor's own plan mode, not this repo's emulation; not "modes" since the hook can't gate the whole surface.
    permissions: "plan",
    // True since the daemon supplies its own ask tool; Cursor's own can fabricate an answer, so it's disallowed.
    questions: true,
    // stdio + http/sse MCP servers plus host callbacks; everything but a Claude Code plugin checkout.
    mcp: "tools",
    execution: ["shell"],
    // Cursor publishes effort as model parameters, not one scale; true here just means it's forwardable at all.
    effort: true,
    fastMode: false,
    // cwd: Cursor's loop runs inside the daemon's own process, whose /work must stay the shared checkout.
    isolation: "cwd",
    // Cursor's commands are files on disk the SDK loads but doesn't publish back, so there's no list to offer.
    commands: false,
    // The SDK runs its shell in-process; there is no tmux session for the terminal panel to attach to.
    terminals: false,
    // The SDK throws typed errors instead of dissolving a refusal into prose, so the adapter files coded frames.
    recovery: true,
    // append, reached differently: `beforeSubmitPrompt`'s reply folds the prompt onto Cursor's base, unreplaceable.
    instructions: "append",
    skillDiscovery: "prompt",
    // The full hook tier, the only foreign runtime to reach it: a hold parks since the vendor waits on the hook.
    rulebook: "hooks",
    // none, structurally: its hooks only allow/deny or are discarded, nothing here to substitute a reference into.
    secrets: "none",
};
