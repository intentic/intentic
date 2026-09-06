/* WHAT EACH AGENTIC LOOP CAN DO, one record per runtime, and nothing about WHICH PROVIDER runs on it.
 *
 * Seven runtimes serve turns behind one seam (AgentRequest in, AgentEvent frames out): the Claude Code Agent SDK
 * loop, Codex app-server, OpenCode (twice, once per channel), Cursor's own loop run in-process, any ACP agent,
 * and Pi's RPC surface. They do NOT do the same things, and for a long time the only thing that said so was a
 * comment inside each adapter, "Ignores the Claude-only request fields", which no surface above it could read.
 * So the composer offered "Ask before each file edit" on a runtime whose every tool call is pre-approved, and
 * offered a reasoning-effort scale to a runtime that drops the field.
 *
 * A capability is listed here only if something READS it: the daemon gates a seam on it, the composer hides or
 * clamps a control by it, or `limitationsOf` tells the user about it. That is the whole point, an ability the
 * matrix claims and nothing consults is how the drift started.
 *
 * THIS FILE IS THE BOTTOM OF THE PROVIDER GRAPH and imports nothing from the rest of the contract, which is
 * what lets provider-specs.ts name these records while schemas/agent.ts reads its provider vocabulary back out
 * of that table. A runtime knows nothing about providers; a provider names two runtimes. Keeping the arrow
 * pointing one way is the whole reason the records live apart from the catalog that reads them.
 *
 * Adding a provider is a row in provider-specs.ts pointing at two of these, not a hunt for literals;
 * agent-catalog.test.ts walks PROVIDERS × HARNESSES and demands one, so a pair can never be silently absent. */

// An execution backend: one way a turn runs work of its own, named for the AgentCapabilities.execution axis
// and for the persona switch that grants it. Adding a language is a member here and a backend in the daemon's
// execution/ module, never a new one-off tool wired where nothing else can see it.
export type ExecutionBackend = "shell" | "js";

export interface AgentCapabilities {
    // Which agentic loop actually serves the turn, the question "is the harness `claude-code`" only looks like.
    // Claude is always its own Claude Code loop and Kimi has no native runtime, so both run it whatever harness
    // the client sent; codex/grok/gemini each have a native runtime to switch away from. Names the session store
    // a finished conversation's transcript is backfilled from, too.
    //
    // `opencode-gemini` is the OpenCode loop pointed at Gemini rather than at xAI, and it is a SEPARATE runtime
    // id from `opencode` on purpose: adapter health is keyed by this field (adapter-health.ts), so sharing one
    // would make Grok's xAI credential decide whether the picker greys out Gemini, and the reverse.
    readonly runtime: "claude-code" | "codex" | "opencode" | "opencode-gemini" | "acp" | "pi" | "cursor";
    // Mid-turn injection (the SteeringQueue behind /agent/steer). Needs the SDK's streaming-input mode.
    readonly steering: boolean;
    // How much of the permission-mode axis the runtime honours. "modes" = every PermissionMode, with per-tool
    // permission cards and `mode` frames when the agent moves itself; "plan" = propose-then-approve or run, and
    // nothing in between, the container is the isolation boundary and every tool call is pre-approved.
    readonly permissions: "modes" | "plan";
    // Can stop mid-turn and ask the user a multiple-choice question (`question` frames).
    readonly questions: boolean;
    /* Which of the turn's tools reach the agent. "full" = http MCP tools + in-process SDK servers + plugin
     * checkouts + the browser servers; "tools" = all of that EXCEPT plugin checkouts; "browser" = the
     * process-backed browser servers alone; "http" = the http MCP tools alone, and only if the agent advertises
     * http MCP support; "none" = the runtime has no seam for them at all. Keeping the partial answers distinct
     * matters: a runtime that can drive a connected account must not be described as tool-less, and one that
     * cannot host daemon-side SDK servers must not claim full.
     *
     * "tools" exists for the Cursor runtime and would have been a lie either way without it. Cursor's SDK takes
     * stdio AND http/sse MCP servers, and its `customTools` run host callbacks in this process, which is the
     * seam an in-process SDK server needs, so calling it "browser" would understate it by three whole
     * categories. What it genuinely cannot host is a Claude Code PLUGIN checkout: that is a directory layout the
     * Agent SDK loads, not a protocol, and no other runtime will ever read one. So the gap is real, permanent
     * and worth its own word rather than being rounded to "full". */
    readonly mcp: "full" | "tools" | "browser" | "http" | "none";
    /* WHICH EXECUTION BACKENDS THE RUNTIME HOSTS, the ways a turn RUNS things, as opposed to the tools it is
     * handed. "shell" is the runtime's own command tool (Bash on the Claude Code loop, each foreign loop's
     * equivalent); "js" is the sandbox's JavaScript backend (execution/ in the daemon): the model writes a
     * script instead of a command line, and the daemon runs it in a permission-fenced Node subprocess.
     *
     * A first-class axis rather than a corollary of `mcp`, because the two answer different questions: `mcp`
     * says which TOOLS reach the model's context, this says which ways of EXECUTING the daemon can stand
     * behind for this runtime, with the same guard, secret and persona seams the shell gets. A runtime that
     * cannot host a backend simply never shows it, and the persona switch for it (PersonaPowersSchema.code)
     * then has nothing to grant there. */
    readonly execution: readonly ExecutionBackend[];
    // Reasoning-effort selection is forwarded to the model.
    readonly effort: boolean;
    /* The runtime can serve a turn at fast speed when asked (AgentTurn.fast). A statement about the LOOP, not
     * about the route: the Claude Code loop knows how to ask for it, which is why every provider this record
     * hands the loop to reads true here, including the ones served through the translator, whose turns the
     * harness will then refuse fast mode for because a translator endpoint is not first-party. That second
     * question is answered where the endpoint is decided (planHarnessTurn), because it is a fact about the
     * CREDENTIAL rather than about the runtime, and this record is a pure function of (provider, harness). */
    readonly fastMode: boolean;
    // How an isolated conversation's worktree is enforced. "namespace" = the worktree IS /work inside the turn's
    // mount namespace (with the tool-input rewrite as the fallback when the container can't build one); "cwd" =
    // the turn is merely cwd'd into the worktree, so an absolute /work path still reaches the shared checkout,
    // which is why those turns are told where their tree is (turn-preamble.ts).
    readonly isolation: "namespace" | "cwd";
    // Publishes its slash commands (`commands` frames) for the composer's `/` popover.
    readonly commands: boolean;
    // Runs its shell in a tmux session the terminal panel can attach to (`terminal` frames).
    readonly terminals: boolean;
    // Fails with the coded frames the daemon's auto-resume keys off (rate_limit, provider-outage), so a turn the
    // provider killed is re-run once the breaker says the provider is back (turn-resume.ts).
    readonly recovery: boolean;
    /* HOW MUCH OF ITS STANDING INSTRUCTIONS THIS RUNTIME WILL TAKE FROM US, the axis behind the sandbox's
     * system-prompt setting (SandboxSettings.systemPromptMode) and the persona's own override.
     *
     * It exists because that setting was silently a Claude Code setting. The composer offers Codex, Grok and
     * Gemini on their own runtimes, and a turn on any of them ignored the prompt the owner had written without
     * saying so anywhere, the one failure mode a settings page cannot recover from, because nothing on screen
     * is wrong. Naming it here means every surface reads the same answer and the daemon composes to it
     * (agent/system-prompt.ts), rather than each learning the exception separately.
     *
     *   "replace", the whole base prompt can be swapped for the owner's text, and extra guidance appended on
     *               top of whichever base is in force. The Claude Code loop (SDK `systemPrompt`) and native
     *               Codex (`model_instructions_file` replaces its base; `developer_instructions` adds a
     *               developer message, both verified on the wire against codex-cli 0.147).
     *   "append" , extra system text only; the runtime's own base prompt stands. OpenCode takes one per
     *               message (`system` on the prompt body), and there is no seam for replacing its base.
     *   "none"   , no system seam at all. What must still reach the model (the persona note) rides the user
     *               message instead, which is the door the delegation note already uses.
     *
     * The BASE CHOICE. Intentic's prompt or Claude Code's, is a "replace" runtime's question and, of those,
     * only the Claude Code loop's: Codex's own base describes Codex's own tools, so swapping it for a prompt
     * written about another harness is the owner's deliberate act (their custom text), never ours. */
    readonly instructions: "replace" | "append" | "none";
    /* HOW THIS RUNTIME DISCOVERS THE WORKSPACE'S LOADED SKILLS.
     *
     *   "native", the runtime scans one of the filesystem projections itself: `.agents/skills/` for Codex,
     *               `.claude/skills/` for the Claude Code loop. Its own loader injects the catalogue and reads
     *               the matching SKILL.md on demand, so adding our own note would duplicate it.
     *   "prompt", the runtime has no loader the daemon can rely on. turn-plan.ts puts the same name,
     *               description and absolute SKILL.md path into the opening user-message preamble. This is a
     *               separate axis from `instructions`: Pi and ACP take no system prompt at all, while OpenCode
     *               and Cursor take an append, but all four still need skill discovery. */
    readonly skillDiscovery: "native" | "prompt";
    /* WHETHER THE OWNER'S SAFETY POLICY REACHES THIS RUNTIME (the document at .intentic/config/safety.md, read
     * by the judge in agent/command-judge.ts, delivered by guard/command-gate.ts).
     *
     * It exists because the policy is silently a Claude Code policy without it. The gate is a PreToolUse hook,
     * which is an Agent SDK seam, so an owner whose policy says "ask before force-pushing" was asked on a Claude
     * turn and never on a Codex, Grok, Gemini, Pi or ACP one, with nothing on screen saying so. Same failure
     * mode as the `instructions` axis above, and the same fix: name it once, let every surface read it.
     *
     *   "hooks"      , the runtime's own pre-execution hook carries the verdict and an ASK can park the call.
     *                  The Claude Code loop, whose PreToolUse hook fires even under bypassPermissions.
     *   "approval"   , the vendor publishes a per-call approval channel the daemon answers from the same
     *                  policy, and an ask parks on a card because the vendor is blocked on the answer
     *                  (Codex's `item/commandExecution/requestApproval`, ACP's `session/request_permission`).
     *                  Weaker than "hooks" in one stated way: the vendor decides WHICH calls it asks about, so a
     *                  command it never raises is one the policy cannot see. What it does raise is judged by
     *                  the same judge.
     *   "refuse-only", the same channel, but the vendor puts a CLOCK on the wait, so a hold cannot park and
     *                  arrives as a refusal instead. OpenCode's turn has an inactivity watchdog that reads a
     *                  paused approval as a stalled turn; a card there would break the turn rather than gate it.
     *                  `refuse` verdicts work fully; an `ask` stops the command and says it could not ask.
     *   "none"       , the runtime publishes no seam before it runs a command, so no policy can apply. Pi runs
     *                  its bash in-process with no approval channel at all.
     *
     * The taint bit rides this axis too: a runtime with no consult has no place to hand the judge its facts,
     * which is why `conversationTainted` must read a "none" runtime as tainted rather than as clean
     * (guard/turn-taint.ts). */
    readonly rulebook: "hooks" | "approval" | "refuse-only" | "none";
    /* WHETHER A STORED CREDENTIAL IS MASKED IN WHAT THIS RUNTIME'S MODEL READS (secrets/secret-registry.ts and
     * the two seams around it).
     *
     * "masked" is the full round trip: every stored value is replaced by its `{{secret:name}}` reference on the
     * way into the model's context, and the same reference resolves back to the value at the two exits that
     * spend it (a shell command, a script). The Claude Code loop, via PostToolUse and PreToolUse.
     *
     * "none" is a STRUCTURAL limit, not an unfinished wire, and it is the reason this axis is honest rather
     * than aspirational. On every other runtime the tool runs inside the VENDOR'S own loop: the model has read
     * the result before the daemon sees any frame about it, so there is no seam left to rewrite. A PostToolUse
     * hook is the only thing that can edit what a model reads, and only the Claude Code loop has one. Nothing
     * about wiring more transports changes that, which is why the answer here is a disclosure and the real fix
     * is to stop putting credentials where a vendor's tool can read them at all.
     *
     * Read by limitationsOf, and by agent/system-prompt.ts, which must not teach the reference language to a
     * runtime that has no exit for it. */
    readonly secrets: "masked" | "none";
}

// The Claude Code Agent SDK loop, the ceiling every other runtime is measured against, and the only one that
// owns the whole request: permission callbacks, the ask tool, plugins, hooks, and the spawn seam a mount
// namespace needs.
export const CLAUDE_CODE: AgentCapabilities = {
    runtime: "claude-code",
    steering: true,
    permissions: "modes",
    questions: true,
    mcp: "full",
    // The one loop with a seam the daemon can put its own backend through, so it hosts the JS backend beside
    // its Bash. Every other runtime below hosts only its own shell.
    execution: ["shell", "js"],
    effort: true,
    fastMode: true,
    isolation: "namespace",
    commands: true,
    terminals: true,
    recovery: true,
    instructions: "replace",
    skillDiscovery: "native",
    // The only runtime with a pre-execution hook of its own, which is why it is the only one where a HOLD can
    // park the call and wait for a card rather than having to refuse it.
    rulebook: "hooks",
    secrets: "masked",
};

/* Codex app-server: item-level events, process-backed MCP servers, and the four interactive seams its protocol
 * actually publishes, `turn/steer` for mid-turn injection, the experimental `item/tool/requestUserInput` server
 * request behind a question card, `skills/list` for the `/` popover (a picked command rides back as a structured
 * skill input), and the same mount namespace the Claude Code loop gets, because app-server is a child process
 * the adapter spawns and nsenter can put it in the turn's namespace like any other.
 *
 * Browser servers ride the per-thread config; daemon-side SDK servers, plugins and server-initiated APPROVALS
 * stay unwired, the container is the isolation boundary, so approvals are declined by design rather than
 * missing (codex-app-server.ts refuses every server request but the question one). */
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
    /* Both halves, through the per-thread `config` block the adapter already sends: `model_instructions_file`
     * takes the place of Codex's own base prompt, `developer_instructions` arrives as an extra developer
     * message ahead of its skills and team blocks. Verified against codex-cli 0.147 by reading what actually
     * reached the wire, the keys are undocumented, and a strings dump proves only that they parse. */
    instructions: "replace",
    skillDiscovery: "native",
    /* App-server publishes `item/commandExecution/requestApproval`, whose params carry the command text, and
     * takes `accept`/`decline` back (codex-cli 0.147's own generated JSON Schema, read with
     * `codex app-server generate-json-schema`). The daemon only asks Codex to raise those requests when the
     * owner has written command rules, so an unconfigured workspace keeps `approvalPolicy: "never"` and pays
     * nothing (codex/codex-agent.ts threadOptions). */
    rulebook: "approval",
    secrets: "none",
};

// OpenCode (the Grok runtime): its own agentic loop, its own tools, allow-all permissions. It takes a model id,
// a prompt and one system message of ours, no effort scale, no tools of ours, no command list.
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
    // `system` on the prompt body, per message. It ADDS to OpenCode's own prompt, there is no seam for
    // replacing that, so a custom prompt lands here as extra instructions, and the settings page says so
    // rather than letting "replaces everything" quietly mean something else on two providers.
    instructions: "append",
    skillDiscovery: "prompt",
    /* OpenCode asks over its own permission channel (`permission.updated`, replied on
     * `/session/{id}/permissions/{permissionID}`, vocabulary once/always/reject), and the daemon judges what it
     * raises with the same decide fn every other runtime uses.
     *
     * REFUSE-ONLY because of its watchdog, not because of its protocol. A Grok/Gemini turn is aborted after two
     * minutes without an event for its session (grok/grok-agent.ts GROK_INACTIVITY_MS), and a permission paused
     * on a person is exactly that silence, so a parked card would turn "ask me" into a broken turn. A `deny`
     * rule is enforced in full; a `hold` stops the command and tells the agent it could not be asked about. */
    rulebook: "refuse-only",
    secrets: "none",
};

/* The same OpenCode loop, serving Gemini instead of xAI, identical abilities, which is the point of giving it
 * its own row rather than its own record shape.
 *
 * It exists because the alternative was Gemini's ONLY route being the Claude Code loop, and that loop announces
 * itself to whatever it is pointed at: the CLI prepends its own "You are a Claude agent, built on Anthropic's
 * Claude Agent SDK." to every request, baked into the binary with no option to suppress it. Google's Antigravity
 * channel matches that exact sentence and refuses the request, reported as a quota error, which sent the
 * translator walking all 31 connected accounts looking for one with room, ~60s per attempt, none of which could
 * ever have answered. Under this runtime the request carries OpenCode's own prompt, so the turn is simply not
 * Claude Code traffic and the block has nothing to match.
 *
 * The credential is unchanged: both harnesses reach Google through the translator and the same auth files. Only
 * the loop around the model differs. */
export const OPENCODE_GEMINI: AgentCapabilities = {
    ...OPENCODE,
    runtime: "opencode-gemini",
};

// Any agent speaking the Agent Client Protocol: a documented floor rather than the native ceiling. It publishes
// commands, runs its terminals in the conversation's tmux session, and takes our http MCP tools when it says it
// can, but it owns its own model, effort and permission posture.
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
    // ACP's `session/new` and `session/prompt` carry no system field: the agent owns its own instructions the
    // same way it owns its model and its permission posture. The persona note takes the user message instead.
    instructions: "none",
    skillDiscovery: "prompt",
    /* `session/request_permission` is in the protocol floor, so every conforming agent has the channel and the
     * daemon answers it from the rulebook (acp/acp-permissions.ts). The caveat the "approval" value already
     * carries is at its widest here: WHICH calls an agent asks about is entirely the agent's choice, and one
     * that never asks is one no rule can reach. */
    rulebook: "approval",
    secrets: "none",
};

// Pi driven over its RPC mode (`pi --mode rpc`, strict-LF JSONL over stdio): above the ACP floor and below the
// Claude Code ceiling. Its `steer` command is real mid-turn injection; `set_thinking_level` takes the effort
// tiers; `get_commands` publishes its extension/skill commands. It has no MCP seam (Pi's own extensions are its
// tool surface), no approval channel (plan is the shared two-phase emulation), and runs bash in-process, no
// tmux session for the terminal panel to attach to.
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
    // Pi's RPC opens a session with a prompt and steers it; nothing in that protocol sets standing
    // instructions, so like ACP it hears the persona note through the user message.
    instructions: "none",
    skillDiscovery: "prompt",
    /* THE ONE RUNTIME WITH NO SEAM AT ALL. Pi runs bash in-process and its RPC publishes no approval request,
     * so there is nothing to consult before a command runs and no rule the owner writes can apply here. Said
     * out loud rather than left to be discovered: limitationsOf renders it, and the taint floor treats a "none"
     * runtime as permanently tainted, because a bit nobody can act on is worse than no bit. */
    rulebook: "none",
    secrets: "none",
};

/* CURSOR'S OWN AGENT RUNTIME, driven through `@cursor/sdk`, the SDK Anysphere publishes, in this daemon's own
 * process. The second-richest row in this file after the Claude Code loop, and the reason is the SDK rather
 * than the vendor: it is an EMBEDDING surface, not a CLI wrapped in a pipe, so most of the seams the other
 * foreign runtimes lack are simply function arguments here.
 *
 * WHY NOT THROUGH OPENCODE, which is already in this image and already serves two providers. Every Cursor
 * bridge for OpenCode is a community reverse-engineering of Cursor's private agent RPC or a localhost shim
 * around its CLI, and the OPENCODE record above is the weakest in this file. Routing Cursor through it would
 * have capped a first-party SDK at Grok's ceiling and made the row depend on a third party's spare time.
 *
 * WHY THE HARNESS AXIS DOESN'T APPLY, the same way it doesn't for Gemini, and for the mirror-image reason.
 * Gemini has no Claude Code route because Google refuses that traffic; Cursor has none because there is no
 * translator route at all, CLIProxyAPI does not serve Cursor as a provider (asked for repeatedly upstream and
 * closed as not planned), and Cursor publishes no OpenAI-compatible endpoint on a subscription. The SDK IS the
 * only door, so `capabilitiesOf` answers this record whatever harness the client sent.
 *
 * The three axes below that read weaker than they could are deliberate, not unfinished: see the notes on each. */
export const CURSOR: AgentCapabilities = {
    runtime: "cursor",
    // The SDK's Run can be cancelled but not written to mid-flight: a second `send` on a busy agent is an
    // AgentBusyError, not an injection. So the steering queue has nowhere to go and the composer hides it.
    steering: false,
    /* Cursor's OWN plan mode (`mode: "agent" | "plan"`), not this repo's two-phase emulation, which is the
     * better version of the same bargain: the model is put in a read-only posture by the vendor rather than
     * being asked to behave.
     *
     * Not "modes", and that is the honest half. The hook seam below can gate shell, MCP, file reads and file
     * edits, which is most of the tool surface but not all of it, and a per-tool posture with a silent gap in
     * it is worse than one that says where it stops. */
    permissions: "plan",
    /* TRUE BECAUSE WE SUPPLY THE TOOL, not because Cursor's own askQuestion is wired. That one is put in
     * `disallowedTools`: in a headless run it has been reported to answer itself with a fabricated "Questions
     * skipped by the user", which is the single worst failure shape available here, an agent acting on consent
     * nobody gave. The ask tool the daemon registers through `customTools` runs in this process, parks on a
     * real card, and cannot invent an answer because it is the thing that receives one. */
    questions: true,
    // stdio + http/sse MCP servers, plus host callbacks through `customTools` (which is where the browser stack
    // and the in-process SDK servers land). Everything but a Claude Code plugin checkout, see the axis note.
    mcp: "tools",
    execution: ["shell"],
    /* Cursor publishes effort as MODEL PARAMETERS rather than as one scale (`ModelListItem.parameters` /
     * `variants` → `ModelSelection.params`), so the shared tiers are mapped onto whatever the selected model
     * declares, and a model that declares none simply offers no control. True here because the axis is
     * forwardable at all; which tiers exist is the live catalog's answer, not this record's. */
    effort: true,
    fastMode: false,
    /* "cwd", and this is the one place the SDK's in-process design costs something. A namespace is built around
     * a CHILD the daemon spawns (that is how the Claude Code loop and Codex app-server get theirs); Cursor's
     * loop runs inside the daemon, whose own /work must stay the shared checkout, so an isolated conversation
     * gets its worktree by working directory and the turn is told where its tree is (turn-preamble.ts). */
    isolation: "cwd",
    // Cursor's commands are files on disk (`.cursor/commands`), which the SDK loads but does not publish back,
    // so there is no list to hand the `/` popover.
    commands: false,
    // The SDK runs its shell in-process; there is no tmux session for the terminal panel to attach to.
    terminals: false,
    // The SDK throws typed errors (RateLimitError and friends) rather than dissolving a refusal into prose, so
    // the adapter can file the coded frames auto-resume keys off.
    recovery: true,
    /* "append", the OpenCode answer, reached by a completely different road. There is no system-prompt argument
     * on `Agent.create`; what there is, is the `beforeSubmitPrompt` hook, whose reply carries
     * `additional_context` that is folded into the request. So the owner's prompt and the persona note DO reach
     * the model, on top of Cursor's own base prompt, and nothing can replace that base. */
    instructions: "append",
    skillDiscovery: "prompt",
    /* THE FULL HOOK TIER, the only foreign runtime that reaches it. Cursor reads `.cursor/hooks.json` in its
     * local runtime, and `beforeShellExecution` answers with `allow` / `deny` / `ask` plus the messages that
     * explain it, with `failClosed` available so a crashed gate blocks instead of waving the command through.
     *
     * What earns "hooks" rather than "approval" is that a HOLD can genuinely park: the hook is a process the
     * daemon wrote, so it blocks on the card and the vendor is simply waiting on a script, exactly the shape
     * that makes the Claude Code loop's PreToolUse hook able to stop and ask. The vendor never decides which
     * calls to raise, either, which is the caveat the "approval" tier carries and this one does not. */
    rulebook: "hooks",
    /* "none", and structurally so, like every other foreign runtime. Masking needs a seam that rewrites what
     * the model READS after a tool ran; Cursor's `afterShellExecution` fires with the output but its reply is
     * discarded upstream, and `beforeReadFile` sees the content only to allow or deny it. Both are gates, not
     * filters, so there is nothing here to substitute a reference back into. */
    secrets: "none",
};
