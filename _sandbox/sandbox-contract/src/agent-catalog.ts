import { type AgentHarness, type AgentProvider, NATIVE_PROVIDERS, type NativeProvider, type PermissionMode } from "./schemas/agent.js";
import type { Model, ModelBadge } from "./schemas/provider-oauth.js";

/* The provider / harness / model catalog every picker shares (the chat menu, the automations dialog), pure
 * data keyed by the wire vocabulary in schemas/agent.ts, so the surfaces can't drift. Live state stays with the
 * consumer (native Grok's model list is the daemon's own catalog for it, layered on top of modelsFor by the
 * web; ACP providers are merged in from the installed `agent` capabilities). */

export interface CatalogOption {
    readonly label: string;
    readonly value: string;
}

// The NATIVE agent runtimes; ACP providers are appended by the consumer from the installed capabilities.
// New conversations use the selection, open ones stay locked (the pill reflects the locked provider). The
// brand logo per provider is drawn by ProviderLogo (by value).
export const PROVIDERS: readonly { label: string; value: NativeProvider }[] = [
    { label: "Claude Code", value: "claude" },
    { label: "Codex", value: "codex" },
    { label: "Grok", value: "grok" },
    { label: "Kimi Code", value: "kimi" },
    // Labelled for the ACCOUNT, not the model family: the `gemini` id names one channel. Google's Antigravity,
    // and that channel vends Claude and GPT-OSS models alongside Gemini's own (see gemini-models.ts). A section
    // headed "Gemini" holding Claude Opus would be a lie; "Google" is what the whole list has in common.
    { label: "Google", value: "gemini" },
    // Cursor's own agent runtime, driven through the SDK Anysphere publishes, on the user's Cursor subscription.
    // Like Google above, the label names the ACCOUNT rather than a model family: the channel vends Anthropic,
    // OpenAI and xAI models alongside Cursor's own Composer, and no model name covers that list.
    { label: "Cursor", value: "cursor" },
];

// What it COSTS to unlock a provider, and what the user connects to do it, the axis the picker groups on, since
// "can this row actually run" is the first thing a model list has to answer. `free` is not a courtesy tier: the
// Google channel serves its models on an ordinary Google sign-in, at no subscription, which is the single most
// useful thing this catalog can tell a user who has connected nothing yet.
export type AccessKind = "free" | "subscription" | "key";

export interface ProviderAccess {
    readonly kind: AccessKind;
    // What the user connects, named the way its vendor names it, this is the noun every connect prompt uses.
    readonly requirement: string;
    // What connecting it lets them run, for the connect gate's one-line pitch.
    readonly runs: string;
}

export const PROVIDER_ACCESS: Record<NativeProvider, ProviderAccess> = {
    claude: { kind: "subscription", requirement: "Claude subscription", runs: "Claude Code" },
    codex: { kind: "subscription", requirement: "ChatGPT subscription", runs: "Codex" },
    grok: { kind: "subscription", requirement: "SuperGrok subscription", runs: "Grok" },
    kimi: { kind: "subscription", requirement: "Kimi Code subscription", runs: "Kimi Code" },
    gemini: { kind: "free", requirement: "Google sign-in", runs: "Gemini, Claude and GPT-OSS under Claude Code" },
    // A `subscription` like the first four, and the requirement names the PLAN rather than the account, because
    // a free Cursor account signs in perfectly and still cannot run a turn here: the SDK behind this provider is
    // gated to the paid tiers. Saying "Cursor account" would send someone to a sign-in that ends in a refusal
    // they had no way to predict.
    cursor: { kind: "subscription", requirement: "Cursor Pro subscription", runs: "Cursor Agent" },
};

/* THE PROVIDERS THAT COST NOTHING, derived from the table above rather than named a second time, and read by
 * every surface that LEADS with a free option instead of merely labelling one.
 *
 * The distinction is worth the export. `accessBadge` answers "what does this row cost" for a row the user is
 * already looking at; this answers "which row should a user who has connected nothing be shown FIRST", which is
 * the connect gate's whole job. Ranking the one free channel last among equal buttons is how a user with
 * no subscription concluded the product needed one. Deriving the list keeps that promotion honest: a channel
 * that stops being free stops being promoted, from one edit to PROVIDER_ACCESS. */
export const FREE_PROVIDERS: readonly NativeProvider[] = NATIVE_PROVIDERS.filter((provider) => PROVIDER_ACCESS[provider].kind === "free");
export const isFreeProvider = (provider: AgentProvider): boolean => FREE_PROVIDERS.includes(provider as NativeProvider);

/* WHOSE ALLOWANCE A TURN ON THIS PROVIDER SPENDS, as the subject of a sentence, a third naming of the same
 * six ids, and the third is not redundancy. PROVIDERS names the RUNTIME the user picks ("Claude Code", "Kimi
 * Code") and PROVIDER_ACCESS.requirement names the thing they CONNECT ("Claude subscription", "Google sign-in");
 * neither reads as English in "… usage limit reached", and neither is what a spent quota belongs to.
 *
 * The routed providers are why this can't be inferred from the harness: a `gemini` turn drives Claude Opus 4.6
 * through Google's Antigravity channel on a plain Google sign-in, so the quota that refuses it is Google's and
 * Anthropic has no part in it. Saying "Claude usage limit reached" there sends the user to check the wrong
 * account, and to a reset that is days out on a pool they never touched. */
export const PROVIDER_VENDOR: Record<NativeProvider, string> = {
    claude: "Claude",
    codex: "ChatGPT",
    grok: "xAI",
    kimi: "Kimi Code",
    gemini: "Google",
    // The plan that gets billed is Cursor's, whichever vendor's model actually answered. A Cursor turn on Claude
    // Opus spends Cursor's included usage and Anthropic has no part in it, the same reasoning that makes a
    // `gemini` turn say "Google" above.
    cursor: "Cursor",
};

// What a turn on this provider costs at the MARGIN, ordering the same three kinds by the only question a
// helper spending the user's money on their behalf has to answer: free is free; a subscription is already paid
// but has a quota the user watches; a key is metered, so every call is real money. Deliberately not folded into
// AccessKind's declaration order, a union's order is not a runtime fact, and this one is relied on.
export const ACCESS_COST: Record<AccessKind, number> = { free: 0, subscription: 1, key: 2 };

/* THE PROVIDER ID OF AN `endpoint` CAPABILITY, a model API the user pointed us at, native or not, near or far.
 *
 * Namespaced rather than bare (which is what ACP agents are) because the two kinds mint providers with OPPOSITE
 * ability records: an ACP agent brings its own loop and gets the documented ACP floor, while an endpoint is
 * driven BY the Claude Code loop and gets its full ceiling. capabilitiesOf answers that from the id alone, so
 * the prefix is what keeps it a pure function of (provider, harness) instead of a lookup against the installed
 * manifest, which the contract cannot see and the browser would have to pass in everywhere.
 *
 * A SLASH, never a colon: `${provider}:${model}` is the picker's own key shape, and quick-model.ts's parsePinned
 * splits a pinned selection on the FIRST colon. `endpoint:ollama:qwen3` would parse as provider "endpoint" with
 * model "ollama:qwen3", a pin that silently resolves to nothing. The capability id (entryId) excludes both
 * characters, so `endpoint/<id>` stays unambiguous in either direction. */
/* THE FREE TRIAL'S ENDPOINT ID IS RESERVED, the way `pi` is, an `endpoint`-kind capability like any model API
 * the user configured, except that this one is provisioned by the DAEMON rather than added by a person, and it
 * points at intentic's own pool (see the sandbox's trial/ and the platform's /trial routes).
 *
 * Riding the endpoint kind is the entire reason the trial needed no new turn path, no new provider and no new
 * adapter: the translator already re-serves an OpenAI-compatible upstream to the Claude Code loop, so a trial
 * turn is an endpoint turn and everything downstream, catalog, picker, routing, works unchanged.
 *
 * What the reserved id buys is the part that must NOT look the same. A trial turn passes through intentic's
 * servers, which no other provider in this product does, and a user cannot consent to something they were not
 * told. So every surface that names a provider asks `isTrialProvider` and says so, and the id is here, beside
 * the vocabulary those surfaces already read, rather than spelled out in each of them. */
export const TRIAL_ENDPOINT_ID = "free-trial";
export const TRIAL_PROVIDER = "endpoint/free-trial";
export const isTrialProvider = (provider: AgentProvider): boolean => provider === TRIAL_PROVIDER;

/* THE ONLY MODEL THE TRIAL PUBLISHES, a synthetic id, not one of Google's, and that is the point.
 *
 * The trial used to publish whatever the upstream listed. Two things were wrong with that and neither could be
 * fixed by filtering harder. Google lists ~54 models on a fresh key and declares `generateContent` for many that
 * cannot serve an agent turn, deep-research, antigravity, gemma, robotics and computer-use previews all pass a
 * capability check and then fail the first message, so the picker was full of rows whose only outcome was an
 * error. And the list MOVED: the translator's routing table is written at boot and on capability edits, while
 * the picker re-reads the catalog every minute, so a model discovered in between was pickable and unroutable,
 * refused with "unknown provider for model".
 *
 * One id, never changing, ends both. There is nothing to filter because nothing is discovered, and the routing
 * table cannot drift from a list of one constant. WHICH real model answers is decided per message by the
 * platform, which is the only party that can see which of its keys still has quota on which model, the sandbox
 * cannot, and a user choosing blind between rows they know nothing about was never a choice worth offering. */
export const TRIAL_MODEL_ID = "auto";
// What the picker calls it, and the sentence the surfaces put underneath. One wording, so the composer's notice
// and the picker's row cannot end up describing different bargains.
export const TRIAL_LABEL = "Free trial";
export const TRIAL_NOTICE = "Trial messages pass through intentic's servers. Connect an account to chat directly.";

export const ENDPOINT_PROVIDER_PREFIX = "endpoint/";
export const endpointProvider = (id: string): AgentProvider => `${ENDPOINT_PROVIDER_PREFIX}${id}`;
export const isEndpointProvider = (provider: AgentProvider): boolean => provider.startsWith(ENDPOINT_PROVIDER_PREFIX);
// The capability id behind an endpoint provider; undefined when the provider is not one.
export const endpointIdOf = (provider: AgentProvider): string | undefined =>
    isEndpointProvider(provider) ? provider.slice(ENDPOINT_PROVIDER_PREFIX.length) : undefined;

// An ACP provider carries its own credentials, installed means runnable, so it has no access requirement at
// all; `undefined` is that state, and every surface reads it as "nothing to connect". An endpoint is the same
// answer for a different reason: its credential (if it even needs one) was configured with the endpoint itself,
// so there is likewise nothing left to connect. What a turn on it COSTS is deliberately not claimed here, a
// self-hosted model on the user's own GPU and a metered gateway key are the same shape to us, and inventing an
// AccessKind for them would have the picker assert a price the daemon has no way to know.
export const accessFor = (provider: AgentProvider): ProviderAccess | undefined => PROVIDER_ACCESS[provider as NativeProvider];

// An ACP provider's label is its capability's display name, which the web layers on top, the raw id is the
// static fallback.
export const providerLabel = (provider: AgentProvider): string => PROVIDERS.find((p) => p.value === provider)?.label ?? provider;

/* Whether a plan-limit reading for this provider is OBTAINABLE at all, one fact, on the wire, because both
 * halves need it and they need the same answer. The daemon reads it to decide what to even ask upstream for
 * (usage/translator-usage.ts); the browser reads it to say WHY an account shows no meter, which is the
 * difference between "this plan publishes nothing" and "we haven't measured yet", two states that look
 * identical as a blank row and mean opposite things.
 *
 * Four can be read, by two mechanisms that stop at the daemon's readers: Claude's rides its own turn (the
 * OAuth usage endpoint, agent.ts), ChatGPT's, Google's and Kimi's are pulled through the translator's
 * credential-scoped api-call. Kimi's endpoint is the platform's own `/coding/v1/usages`, which the Kimi Code
 * subscription's OAuth token reads directly, the bundled translator does not route it, but it does not have
 * to: the api-call substitutes that token server-side like it does for the other two.
 *
 * Grok is the one absence, because xAI's usable billing data needs a subject id CLIProxyAPI keeps out of its
 * auth-file listing, and the fallback probe spends a token to answer. Adding it is adding a reader and its name
 * here, and nothing else. */
export const PLAN_LIMIT_PROVIDERS: readonly NativeProvider[] = ["claude", "codex", "gemini", "kimi"];
export const reportsPlanLimits = (provider: AgentProvider): boolean => PLAN_LIMIT_PROVIDERS.includes(provider as NativeProvider);

// The harness (agentic loop) a turn runs on, orthogonal to the provider. `native` = the provider's own runtime;
// `claude-code` = the Claude Code loop for any provider (codex/grok then route through the translator).
// Surfaced for codex/grok alone. Claude is always its own Claude Code loop; kimi has no native runtime to switch
// to (it only exists under this harness); and GEMINI IS THE MIRROR OF KIMI, it only exists under its native
// one, because Google refuses Claude Code's traffic outright (capabilitiesOf says why). See AgentHarness in
// schemas/agent.ts.
//
// Gemini's `native` is OpenCode rather than a Google CLI: the image ships no Gemini binary, and OpenCode is
// already here driving Grok. It spends the same translator accounts a routed turn would have, what Google
// refuses is the loop, never the credential.
export const HARNESSES: readonly { label: string; value: AgentHarness }[] = [
    { label: "Native", value: "native" },
    { label: "Claude Code", value: "claude-code" },
];

/* WHAT A PROVIDER/HARNESS PAIR CAN ACTUALLY DO, one declaration, read by both sides of the wire.
 *
 * Six runtimes serve turns behind one seam (AgentRequest in, AgentEvent frames out): the Claude Code Agent SDK
 * loop, Codex app-server, OpenCode, Cursor's own loop run in-process, any ACP agent, and Pi's RPC surface. They do NOT do the same things, and for a long time
 * the only thing that said so was a comment inside each adapter, "Ignores the Claude-only request fields",
 * which no surface above it could read. So the composer offered "Ask before each file edit" on a runtime whose
 * every tool call is pre-approved, and offered a reasoning-effort scale to a runtime that drops the field.
 *
 * A capability is listed here only if something READS it: the daemon gates a seam on it, the composer hides or
 * clamps a control by it, or `limitationsOf` tells the user about it. That is the whole point, an ability the
 * matrix claims and nothing consults is how the drift started.
 *
 * Adding a provider is a row here, not a hunt for literals; agent-catalog.test.ts walks PROVIDERS × HARNESSES
 * and demands one, so a pair can never be silently absent. */

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
    /* WHETHER THE OWNER'S COMMAND RULEBOOK REACHES THIS RUNTIME (SandboxSettings.commandRules, decided by
     * guard/actions.ts commandRun, delivered by guard/command-gate.ts).
     *
     * It exists because the rulebook was silently a Claude Code rulebook. The gate is a PreToolUse hook, which
     * is an Agent SDK seam, so an owner who set `files.destructive: hold` was asked on a Claude turn and never
     * on a Codex, Grok, Gemini, Pi or ACP one, with nothing on screen saying so. Same failure mode as the
     * `instructions` axis above, and the same fix: name it once, let every surface read it.
     *
     *   "hooks"      , the runtime's own pre-execution hook carries the verdict and a HOLD can park the call.
     *                  The Claude Code loop, whose PreToolUse hook fires even under bypassPermissions.
     *   "approval"   , the vendor publishes a per-call approval channel the daemon answers from the same
     *                  rulebook, and a hold parks on a card because the vendor is blocked on the answer
     *                  (Codex's `item/commandExecution/requestApproval`, ACP's `session/request_permission`).
     *                  Weaker than "hooks" in one stated way: the vendor decides WHICH calls it asks about, so a
     *                  class it never raises is a class the rulebook cannot see. What it does raise is judged by
     *                  the same decide fn.
     *   "refuse-only", the same channel, but the vendor puts a CLOCK on the wait, so a hold cannot park and
     *                  arrives as a refusal instead. OpenCode's turn has an inactivity watchdog that reads a
     *                  paused approval as a stalled turn; a card there would break the turn rather than gate it.
     *                  `deny` rules work fully; `hold` rules stop the command and say they could not ask.
     *   "none"       , the runtime publishes no seam before it runs a command, so no rule can apply. Pi runs its
     *                  bash in-process with no approval channel at all.
     *
     * The taint floor rides this axis too: a runtime with no consult has no place to apply it, which is why
     * `conversationTainted` must read a "none" runtime as tainted rather than as clean (guard/turn-taint.ts). */
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
const CLAUDE_CODE: AgentCapabilities = {
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
const CODEX: AgentCapabilities = {
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
const OPENCODE: AgentCapabilities = {
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
const OPENCODE_GEMINI: AgentCapabilities = {
    ...OPENCODE,
    runtime: "opencode-gemini",
};

// Any agent speaking the Agent Client Protocol: a documented floor rather than the native ceiling. It publishes
// commands, runs its terminals in the conversation's tmux session, and takes our http MCP tools when it says it
// can, but it owns its own model, effort and permission posture.
const ACP: AgentCapabilities = {
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

/* THE PI CAPABILITY ID IS RESERVED, the same way the six native ids are: an `agent`-kind capability installed
 * under it is served over Pi's own RPC protocol rather than ACP. Pi closed ACP support deliberately (its RPC
 * mode is the embedding surface), and the two want different records. A bare id rather than a namespace like
 * `endpoint/`, because there is exactly one Pi runtime to name; capabilitiesOf still answers from the id alone,
 * which is what keeps it a pure function of (provider, harness). */
export const PI_PROVIDER = "pi";

// Pi driven over its RPC mode (`pi --mode rpc`, strict-LF JSONL over stdio): above the ACP floor and below the
// Claude Code ceiling. Its `steer` command is real mid-turn injection; `set_thinking_level` takes the effort
// tiers; `get_commands` publishes its extension/skill commands. It has no MCP seam (Pi's own extensions are its
// tool surface), no approval channel (plan is the shared two-phase emulation), and runs bash in-process, no
// tmux session for the terminal panel to attach to.
const PI: AgentCapabilities = {
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
const CURSOR: AgentCapabilities = {
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

// The pair → its record. An `endpoint/<id>` provider is a model API the user configured, driven BY the Claude
// Code loop on either harness, so it gets that loop's full ceiling, which is the entire point of routing a
// model through it rather than adopting a second runtime. The reserved `pi` id is the Pi coding agent on its
// own RPC runtime (harness doesn't apply. Pi is its own loop, like ACP). Any other id that names no native
// provider is an installed `agent`-kind capability, served over ACP.
export const capabilitiesOf = (provider: AgentProvider, harness: AgentHarness): AgentCapabilities => {
    if (provider === "codex") {
        return harness === "claude-code" ? CLAUDE_CODE : CODEX;
    }
    if (provider === "grok") {
        return harness === "claude-code" ? CLAUDE_CODE : OPENCODE;
    }
    /* GEMINI IGNORES THE HARNESS, and it is the only routed provider that does. The Claude Code loop announces
     * itself in every request it sends and Google refuses on that announcement (see OPENCODE_GEMINI), so
     * "Gemini under Claude Code" was never a slower or poorer option, it was one that could not complete a
     * single turn, on any of the connected accounts, ever.
     *
     * Answering OPENCODE_GEMINI whatever the caller asked for is what makes that structural rather than a rule
     * each surface has to remember. Everything downstream reads the runtime off this record, the adapter that
     * serves a turn, the transcript store, the quick helper's choice of loop, so there is exactly one place
     * where Gemini's loop is decided, and no way left to route Claude Code traffic at Google by asking for it. */
    if (provider === "gemini") {
        return OPENCODE_GEMINI;
    }
    // Cursor ignores the harness for the mirror of Gemini's reason: there is no route to it but its own SDK. No
    // translator serves Cursor and Cursor publishes no model endpoint on a subscription, so "Cursor under Claude
    // Code" names a road that does not exist. Answering this record whatever was asked for is what keeps that a
    // fact of the catalog rather than a rule each surface has to remember.
    if (provider === "cursor") {
        return CURSOR;
    }
    if (isEndpointProvider(provider)) {
        return CLAUDE_CODE;
    }
    if (provider === PI_PROVIDER) {
        return PI;
    }
    return (NATIVE_PROVIDERS as readonly string[]).includes(provider) ? CLAUDE_CODE : ACP;
};

// Which permission modes a runtime can actually be put in. Under "plan" every other mode collapses onto the
// autonomous posture the runtime already runs, so offering them would be offering four names for two behaviours.
export const modesFor = (capabilities: AgentCapabilities): readonly PermissionMode[] =>
    capabilities.permissions === "modes" ? ["default", "acceptEdits", "plan", "bypassPermissions"] : ["plan", "bypassPermissions"];

// The mode a selection falls back to when the runtime can't hold it, the same shape as clampEffort, and for the
// same reason: a provider switch must not leave the composer showing a posture nothing applies.
export const clampMode = (mode: PermissionMode, capabilities: AgentCapabilities): PermissionMode =>
    modesFor(capabilities).includes(mode) ? mode : "bypassPermissions";

/* What this pair does NOT do, phrased for the person about to send a message to it, the honest half of the
 * picker, and the reason the record carries axes the daemon itself never branches on. Empty ⇒ the full ceiling.
 *
 * `fastMode` is deliberately NOT disclosed here, and it is the one axis that can't be: every other axis is fully
 * determined by the record, while fast mode also depends on the route and the model. The record says true for
 * every provider the Claude Code loop serves, including the ones routed through the translator, which can never
 * go fast, so a sentence derived from it would stay silent for exactly the turns that most need to hear it.
 * fastAllowed answers the real question, and the `fast_mode` frame reports what the turn actually got. */
export const limitationsOf = (capabilities: AgentCapabilities): string[] => [
    ...(capabilities.permissions === "plan" ? ["no per-tool approvals"] : []),
    ...(capabilities.questions ? [] : ["no clarifying questions"]),
    ...(capabilities.steering ? [] : ["no mid-turn steering"]),
    ...(capabilities.mcp === "none"
        ? ["no MCP tools or plugins"]
        : capabilities.mcp === "http"
          ? ["MCP tools only: no plugins or browser"]
          : capabilities.mcp === "browser"
            ? ["browser tools only: no plugins or other MCP tools"]
            : capabilities.mcp === "tools"
              ? ["no plugins: every other tool reaches it"]
              : []),
    ...(capabilities.execution.includes("js") ? [] : ["no code runs, its shell is the one way to execute"]),
    ...(capabilities.effort ? [] : ["no effort control"]),
    ...(capabilities.commands ? [] : ["no slash commands"]),
    ...(capabilities.terminals ? [] : ["no terminal panel"]),
    ...(capabilities.isolation === "namespace" ? [] : ["worktree by working directory only"]),
    ...(capabilities.recovery ? [] : ["no auto-resume after an outage"]),
    /* The two weaker answers on the instruction axis, and only those: "replace" is the ceiling this list
     * measures against, so it has nothing to disclose. Both phrasings name the OWNER'S prompt rather than the
     * mechanism, because that is the thing they wrote and the thing that will or will not be in force. */
    ...(capabilities.instructions === "append" ? ["your system prompt is added to theirs, not replacing it"] : []),
    ...(capabilities.instructions === "none" ? ["your system prompt isn't applied"] : []),
    /* THE TWO SAFETY AXES, phrased as what the OWNER loses rather than as which seam is missing, because both
     * describe something they configured on a settings page and would otherwise assume was in force everywhere.
     *
     * "hooks" and "masked" are the ceiling and disclose nothing. The "approval" middle answer discloses the one
     * thing that genuinely differs from a hook: the vendor picks which calls it asks about, so a rule can only
     * reach what it chose to raise. */
    ...(capabilities.rulebook === "approval" ? ["your command rules apply only to calls this agent asks about"] : []),
    ...(capabilities.rulebook === "refuse-only"
        ? ["your command rules can stop a command here but not pause to ask: a rule set to hold refuses instead"]
        : []),
    ...(capabilities.rulebook === "none" ? ["your command rules aren't applied"] : []),
    ...(capabilities.secrets === "none" ? ["stored secrets reach the model unmasked, and `{{secret:name}}` isn't substituted"] : []),
];

// Claude's compile-time model floor, shared by the daemon's catalog (claude-models.ts, its last rung, reached
// only before either live source has ever answered) and by the web's pre-load list, so the two can't name
// different models. VERSIONED ids only, never the tier aliases (`opus`, `sonnet`) that used to sit here: an
// alias names no version, so a turn running on one leaves the user unable to say what answered them, and it
// lags a release besides, resolving to the previous version for as long as the CLI keeps pointing it there.
// Going stale costs nothing: every rung above replaces the whole list, and a selection the live catalog no
// longer offers is repointed to its default (loadProviderModels web-side, routedModel daemon-side).
export const CLAUDE_SEED_MODELS: readonly Model[] = [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

// The STATIC floor of the model catalog, harness-independent: every provider's real list is the daemon's live
// catalog (/providers/{provider}/models, discovery with a persisted/seed floor, never empty),
// which consumers layer on top. Codex/grok are empty here (nothing sensible to offer before the live load, and
// under the Claude Code harness they route through the translator, which serves the SAME subscription model ids
// as the native catalog, so the harness no longer changes the list).
export const modelsFor = (provider: AgentProvider): CatalogOption[] => {
    if (provider === "claude") {
        return CLAUDE_SEED_MODELS.map((model) => ({ label: model.label, value: model.id }));
    }
    // Codex/Grok/Kimi/Gemini (live catalog only) and ACP providers (the agent owns its model): nothing static.
    return [];
};

// Whether a reasoning-effort tier is actually sendable for this provider with this thinking setting. 'max' is
// the only constrained tier and it fails two ways: no non-Claude scale HAS it, and Claude's API rejects it
// outright when extended thinking is disabled ("effort 'max' is not supported when thinking is disabled on this
// model", a 400 that kills the turn before the model sees it, surfacing only as the SDK's `unknown` error
// category). It is the one rule a MODEL's published tier list can't express, the daemon reports what a model
// accepts without knowing this turn's thinking setting, so the consumer that assembles the offered scale
// (effortsFor, web-side) filters through here, and the clamp over that scale makes the pair unreachable.
export const effortAllowed = (effort: string, provider: AgentProvider, thinking: boolean): boolean =>
    effort !== "max" || (provider === "claude" && thinking);

/* The tier to actually SEND, which is the same rule applied as a repair rather than as a filter.
 *
 * effortAllowed makes the pair unreachable in the picker, and the picker is not the only way a turn is
 * assembled: a route, an extension, a restored tab or a settings-pinned model can all name an effort that no
 * live scale filtered. One did, a session ran `max` with thinking off, and every server-side tool call in it
 * came back `400 output_config.effort 'max' is not supported when thinking is disabled`, which reads to the
 * model as "web search is broken" and cost it the answer it was sent to find.
 *
 * So the daemon repairs the pair at the last gate before the API, taking the API's own advice ("use effort
 * 'high' or below, or enable thinking") rather than reporting it. The TIER is the half that moves: thinking is
 * a deliberate per-turn choice that changes what the turn costs, and silently switching it on would answer a
 * 400 by spending the user's money. */
export const sendableEffort = (effort: string | undefined, thinking: boolean | undefined): string | undefined =>
    effort === "max" && thinking !== true ? "high" : effort;

/* WHETHER FAST SPEED CAN BE OFFERED for a provider/harness/model triple, the picker-side filter, the same
 * shape and the same reason as effortAllowed: the composer must not show a control that does nothing.
 *
 * Three conditions, each answering a different question, and all three are required:
 *
 *   - the RUNTIME has to know how to ask (capabilities.fastMode). Only the Claude Code loop does.
 *   - the ROUTE has to be first-party. Every non-Claude provider the Claude Code loop serves is served through
 *     the sandbox's translator, and the harness refuses fast mode on a non-Anthropic endpoint ("not_first_party")
 *    , so a `grok` turn on the claude-code harness reads true on the capability and still cannot go fast.
 *   - the MODEL has to publish it, which is the `fast` badge Anthropic's own catalog reports per model
 *     (claude-models.ts maps supportsFastMode onto it). Curating a list of ids here instead is what this repo
 *     deliberately does not do, a model that gains or loses fast mode moves the badge, and this follows.
 *
 * `badges` absent ⇒ false. That is the honest reading: a catalog row that published no capabilities said
 * nothing about fast mode, and the seed floor a picker shows before its first live load is exactly that row. */
export const fastAllowed = (capabilities: AgentCapabilities, provider: AgentProvider, badges: readonly ModelBadge[] | undefined): boolean =>
    capabilities.fastMode && provider === "claude" && (badges ?? []).includes("fast");
