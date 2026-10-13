// What each agentic loop can do, one record per runtime, nothing about which provider runs on it. A capability is
// listed only if something reads it: a gate, a control, or limitationsOf. This file is the bottom of the provider graph
// and imports nothing from the rest of the contract, so the arrow points one way.

// An execution backend: one way a turn runs its own work, named for AgentCapabilities.execution and the persona switch
// that grants it.
export type ExecutionBackend = "shell" | "js";

export interface AgentCapabilities {
    // Which loop serves the turn; `opencode-gemini` stays separate since adapter health keys off this field.
    readonly runtime: "claude-code" | "codex" | "opencode" | "opencode-gemini" | "acp" | "devin" | "kimi-cli" | "grok-build" | "pi" | "cursor" | "muse";
    // Mid-turn injection (the SteeringQueue behind /agent/steer); needs the SDK's streaming-input mode.
    readonly steering: boolean;
    // How much of the permission-mode axis the runtime honours: every PermissionMode, or just propose-then-approve.
    readonly permissions: "modes" | "plan";
    // Can stop mid-turn and ask the user a multiple-choice question (`question` frames).
    readonly questions: boolean;
    // Which tools reach the agent, full down to none; never rounded up or down from what a runtime has. Every runtime
    // but `none` takes the turn's whole remote list (TurnTools.remote: the daemon's MCP door's mounts, browsers
    // included, and the mcp-kind cards), so no granted server reaches one runtime and misses another:
    // full - that list, the daemon's own in-process servers (ui, secrets, watch, …), and plugin checkouts.
    // tools - that list, and the daemon's own tools through the runtime's host callbacks; no plugins.
    // http - that list alone, as http MCP servers.
    readonly mcp: "full" | "tools" | "http" | "none";
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
    // Can hold an idle conversation's prompt cache warm: its provider replays the last turn's prefix as one forked,
    // unsaved request with every tool refused (keep-warm). Only where the provider module also implements `warm`.
    readonly warm: boolean;
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
    // How far the sandbox's stored secrets reach this runtime and are kept from its model:
    // masked - a `{{secret:…}}` reference resolves in the shell, and a stored value is masked out of every tool result,
    //   file reads included (the Claude Code loop's PostToolUse hook; Pi's extension, whose tool_result handler sees all).
    // shell - a reference resolves in shell commands and the daemon's own tools, and a value is masked out of what a
    //   command prints and those tools' results, since the daemon runs or wraps the shell; a file the agent reads, a
    //   fetched page and an MCP result reach the model as they are (Cursor refuses a read of a file holding one instead).
    // none - neither: a reference stays text, and a value reaches the model as the tool read it.
    readonly secrets: "masked" | "shell" | "none";
    // Whether the privacy shield can stand between this loop and its provider: `gateway` when the daemon names the base
    // URL the loop sends its model requests to (so the gateway reads and masks every byte of them); `hooks` when the wire
    // is the vendor's own but every channel the model reads through passes the daemon first (the prompt and instructions
    // it hands over, a hook in front of each file read, a shell whose output the daemon masks, MCP behind the masking
    // proxy), so the shield reads by content there too; `none` when the loop talks to its provider on a wire or a
    // configuration the daemon does not own and reads files it never sees. Only a `none` loop on an untrusted provider is
    // refused while the shield is on.
    readonly privacy: "gateway" | "hooks" | "none";
    // Whether a turn's tool list (TurnPolicy.allowedTools, an automation's `allowedTools`) is a real boundary here:
    // every tool call the loop makes passes a check the daemon answers, or the loop is built with only the listed tools.
    // A runtime that runs some tool without asking anyone cannot keep it, so a turn carrying a list never starts on one.
    readonly toolAllowlist: boolean;
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
    warm: true,
    instructions: "replace",
    skillDiscovery: "native",
    // The only runtime with its own pre-execution hook, so the only one where a hold can park instead of refusing.
    rulebook: "hooks",
    secrets: "masked",
    // Every request goes to ANTHROPIC_BASE_URL, which the daemon sets per turn.
    privacy: "gateway",
    // A PreToolUse hook refuses every call off the list, under bypassPermissions and in subagents too
    // (agent/tools/tool-allowlist.ts).
    toolAllowlist: true,
};

// Codex app-server: item-level events, the turn's remote MCP servers and the daemon's own over http, per-thread hooks
// on the door's policy gate, and its seams (steer, a question request, approval requests, the skills list, the shared
// mount namespace). Plugins stay unwired.
export const CODEX: AgentCapabilities = {
    runtime: "codex",
    steering: true,
    // Every mode: `default` raises the per-tool card on each command, patch and sandbox widening Codex asks about
    // (known-safe commands never ask); plan runs Codex's own plan mode under the shared plan card; the rest run.
    permissions: "modes",
    questions: true,
    // The daemon's own servers (ui, accounts, secrets, subagents, watch, deps, diagnostics, code, gate) ride the turn's
    // door lease beside its remote mounts (runtimes/daemon-tools/daemon-servers.ts), each with its own tool timeout.
    mcp: "tools",
    // The JS backend is the door's `code` server, its scripts consulted against the turn's gate before they run.
    execution: ["shell", "js"],
    effort: true,
    // Asks app-server for the tier a model publishes as Fast (serviceTier "priority"), which model/list badges.
    fastMode: true,
    isolation: "namespace",
    commands: true,
    // The gate's PreToolUse answer rewrites each shell command through bin/tmux-run into the conversation's agent tmux
    // session, as the Claude loop's Bash hook does (codex-hooks.ts). Codex's own `write_stdin` then reaches tmux-run,
    // not the program in the pane, and a call tmux-run returns from early ends Codex's process for it.
    terminals: true,
    // Failures arrive typed (codexErrorInfo): a transport or capacity failure is coded provider-outage, a spent
    // allowance rate_limit, a full window context-overflow, so the breaker counts them and auto-resume re-runs them.
    recovery: true,
    warm: false,
    // thread/start's own fields: baseInstructions replaces Codex's base prompt, developerInstructions adds a developer
    // message.
    instructions: "replace",
    skillDiscovery: "native",
    // A per-thread PreToolUse hook puts every function tool (the shell, apply_patch, every MCP tool, spawn_agent) to the
    // door's gate before it runs, which may park it on a card (codex-hooks.ts). Codex fails a hook open, so the gate is
    // confirmed connected before the turn starts, a command or patch Codex asks approval for runs only if the gate
    // allowed that very call, and a call that starts unanswered stops the turn. Codex's own subagents' threads never
    // connect the gate, so there the rules reach only the commands and patches Codex asks about.
    rulebook: "hooks",
    // Shell commands resolve `{{secret:…}}` in the gate's rewrite and run under a wrapper that masks stored values in
    // their output (codex-mask-script.ts); apply_patch, view_image and hosted tools pass no wrapper.
    secrets: "shell",
    // Its model provider's base_url is the daemon's, written into the per-thread config.
    privacy: "gateway",
    // The gate's PreToolUse refuses every call off the list, fail closed on the turn's own thread as above; with a list
    // Codex's hosted search and pictures, its image viewer, question tool and own subagents are switched off, the shell
    // too unless listed, and each MCP server is cut to its listed tools (`enabled_tools`). The residual: a known-safe
    // read-only command off the list runs if the in-process gate fails after it connected, and the turn is then stopped.
    toolAllowlist: true,
};

// OpenCode (the Grok runtime): its own agentic loop and tools, with the turn's remote MCP servers mounted on the shared
// server per conversation, driven over OpenCode 2's session API (runtimes/opencode).
export const OPENCODE: AgentCapabilities = {
    runtime: "opencode",
    // The turn's steering queue is sent as OpenCode steers (`session.prompt` with `delivery: "steer"`): taken in at the
    // model's next step, or starting the next execution of the same turn once its work is done; the turn stays open until
    // the session says it took each one in.
    steering: true,
    // `default` puts every edit, fetch and command the rulebook let through on a per-tool card (session rules asking about
    // them, answered from the card, never "always"); `plan` is still the emulated propose-then-approve, since OpenCode's
    // own plan agent has no card of its own.
    permissions: "modes",
    // OpenCode's `question` tool raises a form, drawn as a question card and answered from it; a form no card can carry
    // is cancelled with a sentence telling the model to carry on.
    questions: true,
    // The turn's remote servers and the daemon's own (ui, accounts, secrets, subagents, watch, deps, diagnostics, code),
    // served through the MCP door on the turn's lease (daemon-tools/door-tools.ts) and added at runtime under the
    // conversation's own names, each session's own rules showing it only its own (opencode-mcp.ts); no plugins.
    mcp: "tools",
    // The daemon's JS backend is the door's `code` server, each script consulted against the turn's gate through the
    // relay the loop attaches (runtimes/daemon-tools/turn-relay.ts).
    execution: ["shell", "js"],
    // The turn's tier is the session's model variant, where the model declares that tier: the Grok 3 Mini line on xAI,
    // and every Google model the translator publishes a thinking scale for.
    effort: true,
    fastMode: false,
    // One `opencode serve` serves every conversation from the daemon's own mount namespace. A server per conversation
    // spawned into its turn's namespace (as Codex and Cursor spawn) is not built, for three reasons found 2026-10-12: its
    // sessions would live in a data dir of their own, so every conversation's existing sessions would have to move there
    // (session.export/import) and back; the xAI sign-in would have to be copied into each (credential.create), and two
    // servers refreshing one OAuth grant is untested; and the shell script's socket and the data dir sit under the
    // daemon's auth dir, which an anchored turn's /work does not show and an agent domain must not reach.
    isolation: "cwd",
    // OpenCode's command list is published each turn, and a `/name` prompt runs as that command.
    commands: true,
    // OpenCode runs its shell as the daemon's script, which runs each command through tmux-run in the conversation's tmux
    // session, and the turn surfaces it with a `terminal` frame (runtimes/opencode/shell/opencode-shell.ts).
    terminals: true,
    // Failures are coded from OpenCode's own failure types: a spent allowance `rate_limit`, a provider's transport,
    // internal or timeout failure (and a retry the turn will not wait out, or a silent provider) `provider-outage`, a
    // session past its window `context-overflow`, an unroutable model `model-unavailable`.
    recovery: true,
    warm: false,
    // A prompt that replaces the base (the owner's own under `custom`, a small window's paragraph) runs on the daemon's
    // twin agents, whose base is blank, so it is the whole system text; anything else is added to OpenCode's own base.
    instructions: "replace",
    skillDiscovery: "prompt",
    // OpenCode raises its permission asks for every shell command, a subagent's included (the server's own rules ask about
    // them all, and a child session inherits them); the daemon answers from the rulebook, a hold parked on a card while
    // the turn's inactivity watchdog is held. The JS backend consults the same gate. Not `hooks`: which calls ask is still
    // OpenCode's permission config (the daemon's rules make it every shell command), and an edit or an MCP call is asked
    // about only where `default` mode puts it on a person's card.
    rulebook: "approval",
    // The daemon's shell script resolves a command's secret references after the rulebook judged it, and masks what it
    // prints back to the references before OpenCode reads it (runtimes/opencode/shell/opencode-shell.ts). A file the read tool opens is not.
    secrets: "shell",
    // The shared server's provider baseURLs are written by the daemon at spawn.
    privacy: "gateway",
    // A turn's list becomes its session's rules: every action denied, the listed ones allowed, the server's asks kept
    // after them, so the model is offered only the listed tools and OpenCode refuses a call to any other; a subagent's
    // session inherits them. Every built-in tool has its own permission action (checked against 2.0.26), and a shell entry
    // narrowed to a command is checked against each command's ask (runtimes/opencode/allowlist/opencode-allowlist.ts).
    toolAllowlist: true,
};

// The same OpenCode loop, serving Gemini instead of xAI, identical abilities. The Claude Code loop announces itself in
// every request, which Google's Antigravity channel refuses; this loop's prompt makes no such announcement.
export const OPENCODE_GEMINI: AgentCapabilities = {
    ...OPENCODE,
    runtime: "opencode-gemini",
};

// Any agent speaking the Agent Client Protocol: a documented floor, not the native ceiling. Publishes commands and
// terminals, takes the turn's remote MCP servers when it advertises http MCP, and uses what else the agent advertises
// per session (its modes, its `thought_level` option, form elicitation); what no agent is bound to advertise stays off.
export const ACP: AgentCapabilities = {
    runtime: "acp",
    steering: false,
    // Every mode: a `default` turn puts each call the agent asks permission for on a person's card (acp-permissions.ts),
    // a plan turn runs the daemon's two phases with the agent's own plan mode under the first where it has one, and the
    // turn's posture moves the session into the agent's matching mode by id or name (acp-modes.ts).
    permissions: "modes",
    // Form elicitation is advertised, and a form parks on the question card (acp-elicitation.ts); whether the agent asks
    // through it is its own choice, as which calls it asks permission for is.
    questions: true,
    // The turn's remote mounts and the daemon's own servers (ui, accounts, secrets, subagents, watch, deps, diagnostics,
    // code) on its door lease (daemon-servers.ts): over http where the agent advertises http MCP, else through the
    // daemon's stdio proxy (acp-mcp-proxy.ts), the transport every ACP agent takes. A warm session keeps the servers it
    // opened with, so one a later turn adds is seen from the next session on.
    mcp: "tools",
    // The JS backend is the door's `code` server, each script asked of the turn's gate before it runs.
    execution: ["shell", "js"],
    // A session's `thought_level` option takes the turn's effort where the agent offers one (acp-model.ts), but this
    // record is every agent's and most offer none, so the picker shows no scale.
    effort: false,
    fastMode: false,
    // One warm process serves every conversation on the agent, each session in its own cwd; a mount namespace belongs to
    // one turn, so a process shared across conversations can stand in none of them. Keying the pool by namespace would
    // give up the warm sessions the pool exists for.
    isolation: "cwd",
    commands: true,
    terminals: true,
    // A failure the agent words as a spent allowance or an outgrown window is coded (acp-agent.ts ACP_FAILURES), but the
    // words are each agent's own and the protocol marks no outage, so nothing promises the codes auto-resume keys off.
    recovery: false,
    warm: false,
    // ACP's calls carry no system field: the agent owns its instructions, the persona note rides the message.
    instructions: "none",
    skillDiscovery: "prompt",
    // In the protocol floor, so every agent has it; which calls it asks about is entirely its own choice. A terminal the
    // daemon runs for it (terminal/create) is asked about here too, unless the permission for it already was.
    rulebook: "approval",
    secrets: "none",
    // The agent picks its own provider and endpoint from its own login and environment.
    privacy: "none",
    // Which calls the agent asks permission for is its own choice, and most run reads without asking.
    toolAllowlist: false,
};

// Devin's own CLI (`devin acp`), the ACP floor with one seam an installed agent lacks: the daemon picks the model, from
// the account's own list, through the session's model option. Its own runtime name, as OpenCode's Gemini twin has, since
// adapter health keys off this field and Devin's readiness is an account and an engine, not an installed card. Its
// modes (`accept-edits`, `smart`, `ask`, `plan`, `bypass` as of CLI 3000.11.3) carry the floor's posture mapping.
export const DEVIN: AgentCapabilities = {
    ...ACP,
    runtime: "devin",
    // Devin's sessions offer no `thought_level` option (CLI 3000.11.3); the model probe reads one should it appear
    // (devin-catalog.ts), and the floor already forwards the turn's effort to it.
    effort: false,
};

// Moonshot's Kimi Code CLI (`kimi acp`), the ACP floor where the CLI's handshake grants more (2.1.1): the daemon picks the
// model from the account's own list through the session's `model` option, and a session offers a `thinking` option in
// the protocol's `thought_level` category, `off` plus the efforts the model declares, which the turn's effort settles
// (acp-model.ts). Its modes (`default`, `plan`, `auto`, `yolo`) carry the floor's posture mapping, and its ask-user
// tool raises a form elicitation, which parks on the question card. It advertises http MCP, so the turn's servers
// reach it directly. Its own runtime name, since its readiness is a CLI sign-in and an engine, not an installed card.
export const KIMI_CLI: AgentCapabilities = {
    ...ACP,
    runtime: "kimi-cli",
    effort: true,
};

// xAI's Grok Build CLI (`grok agent stdio`), the ACP floor where its handshake grants more (1.0.52): the model through the
// session's `model` option and the turn's effort through its `thought_level` option (each model's own levels, `low` to
// `xhigh`). Its modes are `default`, `plan` and `ask`: no bypass mode, so a turn that runs without asking stays in
// `default` and the floor answers each permission it raises from the rulebook. It advertises http MCP.
export const GROK_BUILD: AgentCapabilities = {
    ...ACP,
    runtime: "grok-build",
    effort: true,
    // Its ask-user tool reaches its own client through an xAI protocol extension, not form elicitation, so the daemon
    // switches the tool off for every session it opens (grok-build-cli.ts) rather than leave the model asking nobody.
    questions: false,
};

// Pi driven over its RPC mode: above the ACP floor and below the Claude Code ceiling. Real mid-turn steering, an effort
// scale, a published command list, and a process started per turn with the daemon's instructions, skills, MCP servers
// and namespace (runtimes/pi/pi-rpc.ts). No approval channel: the daemon's own Pi extension stands in front of every
// tool instead (runtimes/pi/pi-hooks.ts).
export const PI: AgentCapabilities = {
    runtime: "pi",
    steering: true,
    permissions: "plan",
    // The daemon's own Pi extension registers an `ask_user` tool on Pi's dialogs, which park on the question card
    // (pi-extension.ts, pi-extension-ui.ts).
    questions: true,
    // The turn's remote servers and the daemon's own (daemon-servers.ts), mounted through the same extension with Pi's
    // built-in MCP and declared to the model; Pi has it from 0.99, an older Pi mounts none, and the turn says so rather
    // than the picker.
    mcp: "tools",
    // The JS backend is the door's `code` server, each script asked of the turn's gate before it runs.
    execution: ["shell", "js"],
    effort: true,
    fastMode: false,
    // An anchored turn's Pi is entered into its mount namespace (nsenter), as Codex's and Cursor's are.
    isolation: "namespace",
    commands: true,
    // The extension's `tool_call` hook rewrites each bash line through bin/tmux-run into the conversation's agent tmux
    // session, as the Claude loop's Bash hook does (pi-hooks.ts).
    terminals: true,
    // Pi reports a provider failure as its own event (auto_retry_end, an errored message_end) carrying the provider's
    // sentence, status code included, which the shared rules code (pi-events.ts PI_FAILURES).
    recovery: true,
    warm: false,
    // `--system-prompt` replaces Pi's base and `--append-system-prompt` adds to it, both per process; `--no-context-files`
    // keeps Pi from loading AGENTS.md a second time beside the daemon's own note.
    instructions: "replace",
    // `--skill` per loaded skill, the persona's filter applied, with Pi's own discovery off (`--no-skills`).
    skillDiscovery: "native",
    // The daemon's extension, loaded with `-e` ahead of any other and whatever the card's command says of discovery, puts
    // every tool call (MCP and codemode calls included) to the turn's own hook socket before it runs, where a held one
    // parks on a card while Pi waits (pi-hooks.ts). A call it cannot ask about is refused, as a handler that throws is,
    // and the turn does not start on a Pi whose extension never said its hooks are in place. It declines trust in the
    // project, so nothing the agent writes into the workspace loads as an extension after it; one the owner installed
    // for Pi itself still sees a call after the rules did.
    rulebook: "hooks",
    // Shell lines resolve `{{secret:…}}` before they run, and the extension's `tool_result` hook masks every stored value
    // in every tool's result, file reads included, as the Claude loop's PostToolUse does; a result it cannot mask is
    // withheld.
    secrets: "masked",
    // Pi calls its provider from its own login; the daemon names no endpoint.
    privacy: "none",
    // The same socket refuses every call off the turn's list, Pi's tools read under the Claude loop's names (bash as
    // Bash, find as Glob) and MCP tools under the same `mcp__<server>__<tool>`; fail closed as above.
    toolAllowlist: true,
};

// Cursor's own runtime, driven through `@cursor/sdk` from this daemon's process; an embedding surface, so most seams
// other runtimes lack are function arguments here. The harness axis doesn't apply: the SDK is the only door.
export const CURSOR: AgentCapabilities = {
    runtime: "cursor",
    // Run.steer injects into the live run; only a `complete_delivered` ack transfers ownership of the message.
    steering: true,
    // Every mode. `default` puts each call that changes something on the per-tool card: the preToolUse and
    // beforeMCPExecution hooks park on it for Cursor's own tools and an MCP server's, a shell command after the rules
    // unless their own card stood in, and the daemon's custom tools ask in their handlers, which Cursor never asks about
    // (cursor-approvals.ts). `plan` runs the daemon's two phases with Cursor's read-only plan mode under the first; the
    // rest run.
    permissions: "modes",
    // True since the daemon supplies its own ask tool; Cursor's own can fabricate an answer, so it's disallowed.
    questions: true,
    // The turn's remote MCP servers plus host callbacks; everything but a Claude Code plugin checkout.
    mcp: "tools",
    // The JS backend rides Cursor's custom-tool seam rather than an MCP server, and consults the rulebook in its
    // handler, since the hook file only covers the shell.
    execution: ["shell", "js"],
    // Cursor publishes effort as model parameters, not one scale; true here just means it's forwardable at all.
    effort: true,
    fastMode: false,
    // The SDK agent of an anchored turn runs in a runtime process born in the turn's mount namespace (the daemon keeps
    // the loop, the tools and the hook gate), so its shell and its edits see the worktree at /work.
    isolation: "namespace",
    // Cursor's commands are files on disk (`.cursor/commands/*.md`) the SDK loads but doesn't publish back, so the daemon
    // reads them itself, publishes the list and sends `/name` as the command's text (cursor-commands.ts).
    commands: true,
    // Every shell command runs through the hook script, which the daemon hands the command as a bin/tmux-run line, so it
    // runs in the `agent-<session>` tmux session the panel attaches to, as a Claude Code turn's Bash does
    // (cursor-terminal.ts). Where tmux-run is not in the image the command runs as the script's own child.
    terminals: true,
    // The SDK throws typed errors instead of dissolving a refusal into prose, so the adapter files coded frames.
    recovery: true,
    warm: false,
    // The owner's replacement prompt replaces Cursor's base through AgentOptions.systemPrompt on an account entitled to
    // it. The entitlement is server-side and answered only by a send, so a turn tries it and an account refused runs the
    // turn again with the replacement folded onto the base through `beforeSubmitPrompt`, remembered for its later turns
    // (cursor-agent.ts); everything else the daemon adds always rides that append.
    instructions: "replace",
    // Cursor's own loader reads every SKILL.md under `.agents/skills/` of each workspace root it is given: the cwd holds
    // the loaded skills, and the worn persona's kit is laid out as a second root (`local.dirs`); a skill the persona
    // withholds is refused at the read tool, the seam the Claude loop's `Skill(<name>)` denial is (cursor-skills.ts).
    skillDiscovery: "native",
    // The full hook tier, the only foreign runtime to reach it: a hold parks since the vendor waits on the hook.
    rulebook: "hooks",
    // Every shell command runs through the hook script: a `{{secret:name}}` reference resolves into what the script runs once
    // the rules let the command through, and what it prints is masked back before Cursor reads it. Not "masked": Cursor's
    // read tool can be refused but not rewritten, so a file holding a stored value is refused there, and what grep, list
    // or an MCP server hands back is not read at all (cursor-secrets.ts).
    secrets: "shell",
    // Cursor's own RPC to its own servers, so no gateway; but the daemon owns every channel the model reads through:
    // it hands over the prompt and instructions, its hooks stand before each file read and rewrite each shell command
    // to mask the output, the tools that read past both (grep, ls, glob, semantic search, fetch, lints) are withheld,
    // and MCP goes through the masking proxy (runtimes/cursor/cursor-shield.ts).
    privacy: "hooks",
    // Three layers (cursor-tool-list.ts): the `tools` option offers only the listed built-ins, a header Cursor's backend
    // holds the main loop and, with `subagentInherit`, every `Task` child to; only the listed MCP servers and custom
    // tools are mounted, and each custom tool checks the list in its handler; and every call Cursor's local executors run
    // passes preToolUse or beforeMCPExecution, which check it (a `Bash(...)` narrowing included) and refuse a call they
    // cannot place in a turn. A turn carrying a list does not start unless those hooks are installed, and a hook the
    // daemon cannot answer refuses a live turn's call.
    toolAllowlist: true,
};

// Muse Code, Meta's coding agent, driven over the Muse Session Protocol: one `muse serve` host per turn, born in the turn's
// mount namespace, its session kept in Muse's own store so the next turn resumes it (runtimes/muse). Meta's own loop for
// Meta's key, and a host for any other model API whose turn the daemon's translator serves on the Responses wire.
export const MUSE: AgentCapabilities = {
    runtime: "muse",
    // turn/steer into the running turn; a steer that arrives after it ended starts the next turn of the same phase.
    steering: true,
    // Every mode: sessions run under approval mode `promptUnmatched`, so Muse raises every shell command off its own allow
    // rules. `default` puts each one the rulebook lets through on the per-tool card; plan runs a planning phase on Muse's
    // `:read-only` profile (every approval refused) under the shared plan card, then executes on `:ask-me`; the rest run,
    // the rulebook still answering every command. Workspace file edits raise nothing on `:ask-me`, so they get no card.
    permissions: "modes",
    // userInput/request parks on the question card and is answered back (userInput/answer, userInput/cancel).
    questions: true,
    // The turn's remote list and the daemon's own servers through the door (daemonServersFor), both as the session's
    // own streamable-HTTP MCP config; no plugin checkouts.
    mcp: "tools",
    // The door's `code` server mounts the JS backend, its scripts consulted against the gate the loop attaches.
    execution: ["shell", "js"],
    // turn/start's reasoningEffort, in Muse's own tier names (the model list says which a model takes).
    effort: true,
    fastMode: false,
    // The host is nsentered into an anchored turn's namespace, so its shell and edits see the worktree at /work.
    isolation: "namespace",
    // Muse's skills are not published back as a list, and a `/name` prompt is not turned into a skill input part.
    commands: false,
    terminals: false,
    // Failures arrive typed (TurnError): a quota-exhausted one is coded rate_limit, a window the session outgrew
    // context-overflow, a model call Muse retried and could not get through provider-outage, a host gone quiet
    // provider-outage too; turn/retryScheduled is shown as the in-turn retry it is (muse-stream.ts).
    recovery: true,
    warm: false,
    // No MSP call carries a system prompt (session config takes only MCP servers), so the daemon's notes ride the
    // message and the owner's replacement prompt is not applied.
    instructions: "none",
    // Muse loads a trusted workspace's own skills from its own directories, which are not the daemon's; the daemon names
    // the loaded ones in the opener.
    skillDiscovery: "prompt",
    // Muse's approval channel, answered from the rulebook; which commands Muse runs without asking (its own allow rules)
    // is its choice.
    rulebook: "approval",
    secrets: "none",
    // A Meta turn talks to api.meta.ai, a base the daemon does not name; Muse also reads files it never shows the daemon.
    privacy: "none",
    // Edits and reads run without asking anyone, so no answer the daemon gives can keep a call off a list.
    toolAllowlist: false,
};
