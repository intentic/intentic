import { createHash } from "node:crypto";
import {
    type AgentCapabilities,
    type AgentEvent,
    type AgentTurn,
    type Capability,
    type IqContextOutcome,
    type Rule,
    type SandboxSettings,
    PI_PROVIDER,
    SandboxSettingsSchema,
    capabilitiesOf,
    envSuffix,
    withoutResumeNote,
} from "@intentic/sandbox-contract";
import { accountsServer } from "../browser/accounts-tools.js";
import { fetchEmailCode } from "../browser/email-codes.js";
import { openBrowserAccount } from "../capabilities/open-account.js";
import { browserOutputDir } from "../browser/browser-artifacts.js";
import { browserServersOf } from "../browser/browser-tools.js";
import { type TurnPersona, personaCapabilities, personaCliEnv, personaDisallowedTools, personaNote, turnPersona } from "../personas/personas.js";
import { personaScopeOf } from "../personas/persona-scope.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { hostToolsOf } from "../capabilities/host-tools.js";
import { mcpToolsOf } from "../capabilities/mcp-tools.js";
import { pluginDirsOf } from "../capabilities/plugin-dirs.js";
import type { Services } from "../composition.js";
import { extensionAgentDirsOf } from "../extensions/installed-extensions.js";
import { createHashlineServer } from "../hashline/hashline-tools.js";
import { runRuleCommand } from "../rules/rule-command.js";
import { standing } from "../rules/rules.js";
import { CHECKS_SESSION } from "../terminal/terminal-session.js";
import type { AgentRequest } from "./agent.js";
import { adapterFor } from "./adapter-registry.js";
import { isUnknownSlashCommand } from "./agent-commands.js";
import type { SteeringQueue } from "./agent-steering.js";
import { withAttachmentNote } from "./attachment-note.js";
import { delegationNote } from "./delegation.js";
import { subagentWaitServer } from "./subagent-wait.js";
import { resolveHarnessCredentials } from "./harness-credentials.js";
import { turnPromptPlacement } from "./system-prompt.js";
import { retrieveTurnContext } from "./turn-context.js";
import { LITERAL_SLASH_NOTE, withTurnPreamble, worktreeNote } from "./turn-preamble.js";
import { createDepsServer } from "../workspace/deps-tools.js";
import { dependencyDirForCommand } from "./agent-deps.js";
import { setupNoticeFor } from "../workspace/workspace-setup.js";
import { iqSearchInstruction } from "./iq-search-instruction.js";

/* WHICH RUNTIME SERVES A TURN, AND WHAT IT IS HANDED — the one question every turn has to answer before it can
 * stream anything, and the one the turn route used to answer inline as a four-arm if/else chain wrapped around
 * its own lifecycle bookkeeping.
 *
 * Each provider answers it the same four ways and differs only in the details: gate the credential, name the
 * runner, name the account the usage frames are attributed to, and assemble the request. Writing that out per
 * arm is what let the arms drift — the Codex gate resolved a concrete model so the CLI's built-in default could
 * never leak through, and the Grok gate learned the same lesson separately, months later.
 *
 * A REFUSAL IS A VALUE, exactly as in harness-credentials.ts (which this calls, and whose header explains why).
 * Every one is an ordinary state of a sandbox — a subscription nobody connected, an Agent capability that was
 * uninstalled — rather than an exception, and every one needs the USER. A session the runtime has forgotten used
 * to be among them and is not any more, on exactly that test: the daemon can answer that one itself, by seeding
 * a fresh session from the conversation's record (agent.routes.ts sessionToResume). The route turns a refusal
 * into the single error frame the composer's connect gate reads; the previous shape spelled that frame out five
 * times, and each copy was also a `return` that skipped the caller's cleanup (see the anchor it leaked). */

export type TurnRefusal = {
    readonly ok: false;
    // The machine-readable discriminator the UI keys off (AgentEvent's `error`); absent on plain failures.
    readonly code?: Extract<AgentEvent, { kind: "error" }>["code"];
    readonly message: string;
};

export type TurnPlan =
    | TurnRefusal
    | {
          readonly ok: true;
          readonly run: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
          // The provider account serving this turn — the attribution key stamped onto the usage/rate-limit
          // frames and the activity log. Undefined when the credential came from the container env, or from a
          // translator subscription rather than an account this sandbox stores.
          readonly account?: string;
          // Which arm of the terse experiment this turn was built on, when it was in the experiment at all —
          // stamped onto the spend ledger at turn end (UsageTurn.terse) because that is the only record of it.
          // It rides the plan rather than the request: the request is what the SDK is handed, and the steer has
          // already been folded into the prompt by the time one exists.
          readonly terseArm?: boolean;
          // The same, for the pre-injected workspace context (UsageTurn.iqContext). True means the turn was
          // ASSIGNED the retrieval, not that it found anything — see the ledger field's note on why the arms
          // have to be the coin flip's populations rather than the ones retrieval happened to serve.
          readonly contextArm?: boolean;
          // What became of the retrieval (UsageTurn.iqContextOutcome). The companion to `contextArm`, not a
          // replacement for it: the arm keeps the experiment honest, this says how much of the treatment arm the
          // treatment reached and what took away the rest — the difference between a small effect and a diluted
          // one, and then between a dilution worth fixing and one that is the gate doing its job.
          readonly contextOutcome?: IqContextOutcome;
          readonly contextDurationMs?: number;
          // The iq-search teaching experiment's CONVERSATION-level arm. It cannot flip per turn: once a skill
          // has entered a provider session, a later control turn in that session is already contaminated.
          readonly searchArm?: boolean;
          readonly searchCohort?: string;
          readonly request: AgentRequest;
      };

// What the route has already resolved by the time a provider can be picked: the request every arm builds on,
// the turn's two cwds (see runTurn on why there are two), and the seams only some arms use.
export interface TurnContext {
    readonly base: AgentRequest;
    // Workspace-relative attachments, already resolved to absolute paths and escape-checked by the route.
    readonly attachmentPaths: readonly string[];
    // The tree as the DAEMON reaches it — what the daemon itself runs against the files (hashline edits, the
    // dependency probe) must use, because the daemon is not in the turn's namespace.
    readonly localCwd: string;
    // The workspace root as the AGENT sees it — what a session id is looked up against.
    readonly effectiveCwd: string;
    readonly cliEnv: Record<string, string>;
    // Mid-turn steering, present only where the runtime declares it (capabilitiesOf().steering — the Claude
    // Code loop's streaming input, and Pi's own steer queue).
    readonly steering: SteeringQueue | undefined;
    // Resolved once above the provider split. Optional only for focused callers that invoke an arm directly.
    readonly settings?: SandboxSettings;
    readonly conversationTurns?: number;
    readonly iqSearchEnabled?: boolean;
    readonly iqSearchNote?: string;
    readonly iqSearchCohort?: string;
    /* Who the turn is and what it may do, resolved once by planTurn and handed down (personas/personas.ts).
     * Set only on the context the arms receive — the route builds this object before a card has been read, so
     * it is absent there and present everywhere it is used. */
    readonly persona?: TurnPersona;
    /* Re-take the pre-turn rebase while the turn is parked on a card (agent.routes.ts owns the git and the
     * bookkeeping; agent.ts picks the moments). Isolated turns only — a main-tree turn has no branch to move.
     *
     * Harness-only, like steering and for the same reason: the cards that park a turn long enough for the
     * main line to move are the harness's own (the `ask` tool, the plan gate). A native codex/grok/ACP turn
     * has no seam to call it from, so handing it one would be a field nothing reads. */
    readonly resync?: () => Promise<AgentEvent | undefined>;
}

/* WHY EVERY STEP IN HERE IS MEASURED, and why they run together rather than one after another.
 *
 * Planning a turn is nothing but independent I/O — a capability listing, a dependency probe, a token refresh, a
 * settings read, a browser bring-up, a delegation lookup — and it was written as a chain of awaits, so a turn
 * paid the SUM of them. The daemon's own preflight marks (agent.routes.ts) recorded 5 to 22 seconds sitting
 * inside a single stage called `plan`, which is where the marks stopped: the one number anybody had said the
 * slow thing was "planning", and planning is a dozen things. Now each one files its own span, so the next slow
 * turn names the step instead of the phase — and because they overlap, the turn pays the SLOWEST rather than
 * the total. Nothing here reads anything else here, with two exceptions the harness arm spells out.
 */
export const conversationExperimentArm = (conversationId: string | undefined, holdout: number): boolean => {
    if (conversationId === undefined) {
        return Math.random() >= holdout;
    }
    const bucket = createHash("sha256").update(`iq-search:${conversationId}`).digest().readUInt32BE(0) / 0x1_0000_0000;
    return bucket >= holdout;
};

export const planTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    // Harness (agentic loop) is orthogonal to provider: "native" runs each provider on its own runtime;
    // "claude-code" forces the Claude Code Agent SDK loop for ANY provider — codex/grok then fall through to the
    // harness plan below, which serves them by pointing the harness at the sandbox's translator. The pair's
    // declared record (capabilitiesOf) names the runtime, so the arm that serves a turn and the abilities the
    // rest of the daemon gates on can't disagree: both read the same row.
    const provider = input.agent ?? "claude";
    const harness = input.harness ?? "native";
    const capabilities = capabilitiesOf(provider, harness);
    const [installed, setup, cast, settings] = await Promise.all([
        // cli/mcp/plugin/browser/agent-kind capabilities, read once and shared by the arms that need them. NOT
        // the record above — these are what the OWNER installed, that is what the runtime can DO.
        services.perf.track("turn.plan.capabilities", {}, () => services.capabilities.list()),
        /* Dependency readiness — asked of the MAIN checkout, and this is the one place in the daemon where
         * "the tree this turn works in" is the wrong tree to ask about.
         *
         * An isolated turn's worktree carries no installed dependencies of its own. It gets them from the main
         * checkout: an overlay mount inside the turn's namespace, or a symlink at the same relative path when
         * the container cannot build one (agents/worktrees.ts). Both resolve THROUGH /work, so /work's answer
         * is the turn's answer. The daemon, however, stands outside that namespace — where the overlay is an
         * EMPTY DIRECTORY. So probing the worktree found the marker (the empty mount point), walked it, found
         * nothing in it, and reported every declared dependency in the workspace as not installed: on this
         * repository, 663 of them, in a paragraph telling the model its imports are only failing because an
         * install is behind. None of it was true, and it was stapled to the front of every isolated turn.
         *
         * Resolved HERE, ahead of the dispatch, because it is true of every runtime — see `honoured`. */
        // Full runtimes ask through the dependency server, and a native runtime needs the fallback notice only
        // when its provider session opens. Re-scanning the whole workspace for every follow-up merely to throw
        // the answer away was the CPU version of the context bloat this change removes.
        capabilities.mcp === "full" || context.base.sessionId !== undefined
            ? Promise.resolve([])
            : services.perf.track("turn.plan.deps", {}, () => services.dependencies.status()),
        // The cards themselves — one small JSON file, read unconditionally. Making the read conditional on
        // `actsAs` being set would skip exactly the case that matters most: an unattended wake that named
        // nothing, whose correct answer is "no accounts" and which must not reach one by saying nothing at all.
        services.perf.track("turn.plan.personas", {}, () => services.personas.list()),
        services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get()),
    ]);
    /* WHO THIS TURN IS AND WHAT IT MAY DO — resolved ABOVE the provider split, which is the whole reason this
     * moved here from the harness arm.
     *
     * It used to be resolved inside the Claude Code plan, so a native Codex, Grok, Pi or ACP session ignored the
     * card entirely: the same automation, pinned to the same read-only persona, was bounded on one runtime and
     * unbounded on another depending on a dropdown nobody associates with security. For an account filter that
     * was already wrong; for a toolbox it is the difference between a fence and a decoration.
     *
     * Every session start in the sandbox passes through this function — the chat, an automation wake, a Doorbell
     * message, a workflow step, a loop iteration — so this is the one place that can answer the question once
     * and have every surface inherit it. */
    const persona = turnPersona({ personas: cast, actsAs: input.actsAs, unattended: input.unattended === true });
    if (persona.reason === "unknown-persona") {
        // Worth a line of its own: the turn asked to act as somebody and this workspace has no such card, so it
        // is about to run with nothing at all and the prompt will read as though it should have had everything.
        services.logger.warn({ actsAs: input.actsAs }, "persona: no such card — this turn reaches no account and no tools");
    }
    /* The manifest as this turn may see it, narrowed ONCE and handed to every arm in place of the full list.
     * Filtering here rather than in each arm is what makes a shelf mean the same thing on every runtime, and
     * what keeps a capability kind added tomorrow from being quietly denied to everybody (personas.ts). */
    const granted = personaCapabilities(installed, persona);
    const conversationTurns = input.conversationId === undefined ? 0 : (services.agents.entry(input.conversationId)?.turns ?? 0);
    const searchArm =
        settings.iqSearch && settings.iqSearchHoldout > 0 && input.conversationId !== undefined
            ? conversationExperimentArm(input.conversationId, settings.iqSearchHoldout)
            : undefined;
    const iqSearchEnabled = searchArm ?? settings.iqSearch;
    // Claude Code loads the source as a plugin. Runtimes without that seam receive the same source text once,
    // on the conversation's opening request; their provider session carries it through later turns.
    const teaching =
        services.config.iqPluginDir !== "" &&
        (searchArm !== undefined || (capabilities.runtime !== "claude-code" && iqSearchEnabled && conversationTurns === 0))
            ? await iqSearchInstruction(services.config.iqPluginDir).catch((error: unknown) => {
                  services.logger.warn({ err: error }, "iq search: could not load the cross-harness instruction");
                  return undefined;
              })
            : undefined;
    const iqSearchNote = capabilities.runtime !== "claude-code" && iqSearchEnabled && conversationTurns === 0 ? teaching?.note : undefined;
    const shared: TurnContext = {
        ...context,
        settings,
        conversationTurns,
        iqSearchEnabled,
        ...(iqSearchNote !== undefined ? { iqSearchNote } : {}),
        ...(teaching !== undefined ? { iqSearchCohort: teaching.cohort } : {}),
    };
    const planned: TurnContext = {
        ...shared,
        base: honoured(services, shared, capabilities, setupNoticeFor(setup), persona, installed),
        persona,
    };
    // The dispatch, through the registry rather than an if/else chain over the same union — so the set of
    // runtimes has one declaration, and the health probe the picker reads is written next to the arm it
    // predicts (see agent/adapter-registry.ts).
    const plan = await adapterFor(provider, harness).preflight(services, input, planned, granted);
    return plan.ok && searchArm !== undefined ? { ...plan, searchArm, ...(teaching !== undefined ? { searchCohort: teaching.cohort } : {}) } : plan;
};

/* THE REQUEST EVERY ARM BUILDS ON, with the controls this runtime does not honour already gone.
 *
 * An adapter that silently drops a field is how the composer came to offer "Ask before each file edit" on a
 * runtime whose every tool call is pre-approved: the request said one thing, four hundred lines away something
 * else did another, and the turn journal recorded the request. Dropping them HERE means an adapter only ever
 * reads a request it fully honours, and the record is the only thing that decides which those are.
 *
 * The worktree note is the same idea pointed at the filesystem: a runtime that declares `isolation: "cwd"` gets
 * neither the mount namespace nor the tool-input rewrite, so the one thing left that can keep it inside its own
 * branch is telling it where the branch is (turn-preamble.ts explains why that is second-best and unavoidable).
 *
 * The SYNC note is here rather than in an arm because it is true of every runtime: the pre-turn rebase moved
 * the files under whichever model is about to read them (agents/sync.ts). This is the one point all four arms
 * pass through, so it is the only place a note can be added without being silently absent from three of them —
 * the harness arm wraps its own preamble layer around whatever comes out of here, which stripTurnPreamble
 * peels back off.
 *
 * THE DEPENDENCY NOTICE IS HERE FOR EXACTLY THAT REASON, having spent its life in the harness arm where three
 * runtimes could not see it. It is the one fact a turn cannot deduce and will otherwise be misled by — that an
 * import failing to resolve right now is the install being behind, not the code being wrong — and a Codex or
 * Grok session without it reads a wall of true-looking errors and starts editing correct source to satisfy
 * them. It also made the same request arrive as two different messages depending on who was serving it, which
 * is fatal to the one thing a workflow of two models exists to measure: run the same brief on Claude and on
 * Codex and the only difference must be the model. Rides the USER message, never systemAppend: it changes the
 * moment an install finishes, and the system prefix is kept byte-stable for the prompt cache.
 *
 * THE PERSONA'S SHELVES ARE APPLIED HERE FOR THE SAME REASON THE DEPENDENCY NOTICE IS. A bound that holds on one
 * runtime and not on the other three is not a bound; this is the single point all of them pass through, so the
 * connectors whose credentials are withheld and the tools taken out of the turn are the same set whoever serves
 * it. What CANNOT be applied here is anything capability-shaped that an arm builds for itself — those are
 * filtered upstream, out of the manifest each arm is handed (personaCapabilities). */
const honoured = (
    services: Services,
    context: TurnContext,
    capabilities: AgentCapabilities,
    setupNotice: string | undefined,
    persona: TurnPersona,
    // The UNFILTERED manifest — this needs to know which connectors exist in order to know whose credentials to
    // withhold, which the already-filtered list by definition cannot say.
    installed: readonly Capability[],
): AgentRequest => {
    const { permissionMode, effort, fast, cliEnv, disallowedTools, ...rest } = context.base;
    // An isolated conversation's worktree is not the workspace root; a main-tree turn has nothing to say.
    const isolated = context.localCwd !== services.workspace.root;
    const notes = [
        ...(isolated && capabilities.isolation === "cwd" ? [worktreeNote(context.localCwd, services.workspace.root)] : []),
        /* THE DEPENDENCY NOTICE IS NOW THE FALLBACK RATHER THAN THE MECHANISM, and only for the runtimes that
         * have no mechanism to fall back FROM.
         *
         * A `full` runtime is handed the readiness tools and the two notices that fire on a real failure — a
         * post-edit type-check and a post-command miss (agent-deps.ts) — and every one of those addresses the
         * turn that actually went near a drifted project. Pushing the paragraph as well would be paying for the
         * same three facts on every turn in the conversation, whether or not it ever touched one; it is the
         * repetition, not the wording, that made a sentence written to be read once into context bloat.
         *
         * The other runtimes get neither tools nor hooks — there is no seam in them to put either through — so
         * for those the paragraph is still the only thing standing between a model and a wall of true-looking
         * unresolved-import errors. It stays where it is, unchanged, for exactly as long as that is true. */
        ...(setupNotice !== undefined && capabilities.mcp !== "full" ? [setupNotice] : []),
        ...(context.iqSearchNote !== undefined ? [context.iqSearchNote] : []),
    ];
    // The connectors this card did not grant, taken out of the shell's environment rather than left in it with
    // an instruction not to look. The manifest is read from the context's own base, which is the unfiltered
    // list — the filtered one is what the ARMS get, and this is the same decision applied to the environment.
    const shellEnv = cliEnv === undefined ? undefined : personaCliEnv(cliEnv, installed, persona, envSuffix);
    // The shelves that are not capability-shaped, as tool names the runtime knows. Concatenated with whatever
    // the request already carried (the hashline swap sets its own) rather than replacing it.
    const denied = [...(disallowedTools ?? []), ...personaDisallowedTools(persona)];
    /* WHERE THE CARD SAYS TO STAND — a folder under the turn's own root, which is the worktree for an isolated
     * turn and the workspace for a shared one, so "start in this repo" means the same thing either way.
     *
     * Resolved through the workspace escape guard, and a path that fails it is DROPPED rather than refused: the
     * card is committed config a person hand-edits, and the honest failure for a typo'd folder is a session
     * that opens at the workspace root — not one that will not start at all, at 3am, for a job whose actual
     * work was never going to touch that folder anyway. */
    const startIn = persona.workspace?.startIn;
    const startPath = startIn === undefined || startIn === "" ? undefined : resolveWithin(context.effectiveCwd, startIn);
    const dependencyDir = startIn ?? "";
    const dependencyInstallAllowed = persona.powers.files === "write" && persona.powers.shell;
    /* The folder limit and the sandbox switch, carried on the request for the runtime that can enforce them.
     * The folders resolve against the workspace root rather than `startPath` — the card spells them
     * workspace-relative, and a persona that starts in one repo while being allowed to read a sibling is an
     * ordinary answer that anchoring them to the start folder would make unsayable. */
    const scope = personaScopeOf(persona, context.effectiveCwd);
    return {
        ...rest,
        prompt: withTurnPreamble(notes, context.base.prompt),
        // Set HERE because this is the one point every runtime passes through, and because it is the only place
        // that can still tell the workspace root from the turn's cwd — below this, a persona's start folder and
        // an isolated worktree have already overwritten it.
        workspaceRoot: services.workspace.root,
        dependencyIssue: (command) => services.dependencies.issueAt(dependencyDirForCommand(dependencyDir, services.workspace.root, command)),
        dependencyInstallAllowed,
        ...(startPath !== undefined ? { cwd: startPath } : {}),
        ...(scope !== undefined ? { personaScope: scope } : {}),
        ...(shellEnv !== undefined && Object.keys(shellEnv).length > 0 ? { cliEnv: shellEnv } : {}),
        ...(denied.length > 0 ? { disallowedTools: denied } : {}),
        // A "plan" runtime knows two postures: propose-then-approve, or run. Every other mode names the second
        // one, so it travels as the absence it already meant.
        ...(permissionMode !== undefined && (capabilities.permissions === "modes" || permissionMode === "plan") ? { permissionMode } : {}),
        ...(effort !== undefined && capabilities.effort ? { effort } : {}),
        // Fast speed, for the runtimes that can ask for it — the Claude Code loop alone. The second half of the
        // rule (a routed turn's endpoint is not first-party, so the harness would refuse) is applied where the
        // endpoint is chosen, in planHarnessTurn: this record is a pure function of (provider, harness) and
        // cannot see a credential.
        ...(fast === true && capabilities.fastMode ? { fast } : {}),
    };
};

// Codex has no sandbox-owned OAuth: it authenticates through the translator on the user's ChatGPT SUBSCRIPTION
// (the same connection the claude-code harness rides), or the container OPENAI_API_KEY on a bare dev run with no
// translator. Claude-only fields (plugins, MCP, thinking) don't apply here.
export const planCodexTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    // The subscription (via the translator) is the credential; the container OPENAI_API_KEY is the only fallback
    // (a bare dev run with no translator baked).
    const translatorReady = services.config.translator.url !== "" && (await services.cliProxy.accounts()).codex.length > 0;
    if (!translatorReady && services.config.openaiApiKey === "") {
        return {
            ok: false,
            code: "subscription-required",
            message:
                services.config.translator.url === ""
                    ? "This sandbox has no model translator, so Codex can't run here. Run a sandbox built from the published image."
                    : "Connect your ChatGPT subscription in Sandbox ▸ Agent to run Codex.",
        };
    }
    // Resolve a concrete model so app-server never falls back to the Codex CLI's built-in default
    // (gpt-5-codex), which the subscription can reject. An explicit selection rides through (a stale one
    // self-heals via codex-model-invalid); an empty one resolves the catalog default (discovery → persisted →
    // seed floor, never empty — see codex-catalog).
    const model = input.model !== undefined && input.model !== "" ? input.model : (await services.codexModels.models()).default;
    const withModel = { ...context.base, model };
    // A subscription-served turn rides the translator's OpenAI-compatible endpoint on the fixed local bearer (the
    // adapter builds the provider block); the dev api-key path uses Codex's own OPENAI_API_KEY default. The
    // default CODEX_HOME (createCodexAgent) serves every turn — no per-turn home. Codex takes attachments
    // structurally: images ride as native local_image inputs, the rest as a file list in the prompt.
    const withAuth = translatorReady
        ? { ...withModel, codexEndpoint: { baseUrl: services.config.translator.url, authToken: services.config.translator.token } }
        : withModel;
    return {
        ok: true,
        run: services.codexAgent,
        // Attribution key: the shared subscription serving all Codex turns, else undefined for the api-key fallback.
        ...(translatorReady ? { account: "codex-subscription" } : {}),
        request: withAttachments(withAuth, context.attachmentPaths),
    };
};

// Grok rides OpenCode with xAI subscription OAuth (OpenCode owns the credential). Gate on OpenCode's own
// connection view. Claude-only fields (plugins, MCP tools, thinking) don't apply.
export const planGrokTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    if (!(await services.openCode.connected("xai"))) {
        return {
            ok: false,
            message: "No Grok account connected — sign in with your xAI (SuperGrok/X Premium) account in Setup before chatting.",
        };
    }
    // Grok MUST ride an explicit, live-valid xAI model id: OpenCode's own default is a retired models.dev id
    // (grok-code-fast-1) xAI rejects, and its catalog is empty for xai — so an omitted model makes the turn fall
    // back to that same retired default. Resolve from the daemon's catalog (never empty — live discovery with a
    // persisted/seed floor): keep the pinned model when it's offered, else the default. If the resolved id turns
    // out stale, the runner self-heals it mid-turn from xAI's "Did you mean" rejection (grok-agent).
    const catalog = await services.openCode.xaiModels();
    const valid = new Set(catalog.models.map((entry) => entry.id));
    const model = input.model !== undefined && valid.has(input.model) ? input.model : catalog.default;
    return {
        ok: true,
        run: services.grokAgent,
        // OpenCode holds one xAI auth, so the single Grok account is "xai" (see grok.routes.ts).
        account: "xai",
        // Override base's input.model with the validated id; the adapter folds attachment paths into the prompt
        // (OpenCode's tools read them from disk).
        request: withAttachments({ ...context.base, model }, context.attachmentPaths),
    };
};

// Pi: the reserved `pi` agent-kind capability, spawned and driven over Pi's own RPC protocol. Harness doesn't
// apply (Pi is its own loop). Unlike the ACP floor it takes the steering queue (Pi's `steer` command is real
// mid-turn injection) and the effort tier (set_thinking_level); it has no MCP seam, so no tools are passed.
export const planPiTurn = async (services: Services, _input: AgentTurn, context: TurnContext, granted: readonly Capability[]): Promise<TurnPlan> => {
    const capability = granted.find((entry) => entry.kind === "agent" && entry.id === PI_PROVIDER);
    if (capability === undefined || capability.kind !== "agent") {
        return { ok: false, message: "Pi is not installed — add the Pi Agent capability first." };
    }
    return {
        ok: true,
        run: (turnRequest) => services.piAgent(capability.config, turnRequest),
        request: withAttachments(
            context.steering !== undefined ? { ...context.base, steering: context.steering } : context.base,
            context.attachmentPaths,
        ),
    };
};

// An ACP provider: the id of an installed `agent`-kind capability, spawned and driven over the Agent Client
// Protocol. Harness doesn't apply (the agent IS its own loop) and neither do the Claude-only request fields; the
// adapter passes http MCP tools through when the agent advertises support.
export const planAcpTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
    provider: string,
): Promise<TurnPlan> => {
    const capability = granted.find((entry) => entry.kind === "agent" && entry.id === provider);
    if (capability === undefined || capability.kind !== "agent") {
        return { ok: false, message: `Unknown agent provider "${provider}" — add it as an Agent capability first.` };
    }
    const acpConfig = capability.config;
    const tools = [...services.tools, ...mcpToolsOf(granted), ...hostToolsOf(granted, services.config.sandbox.port, services.hostBridgeToken)];
    return {
        ok: true,
        run: (turnRequest) => services.acpAgent(provider, acpConfig, turnRequest),
        request: withAttachments(tools.length > 0 ? { ...context.base, tools } : context.base, context.attachmentPaths),
    };
};

/* WHAT AN UNTOUCHED SETTING LOOKS LIKE, so a cap the owner never moved can be told from one they set to the
 * same number — the difference decides whether the harness is handed an env var at all (see the subagent caps
 * below). Read off the schema rather than restated here: two lists of defaults would be one list of defaults
 * and one list of stale numbers. */
const SETTINGS_DEFAULTS = SandboxSettingsSchema.parse({});

// How much of a failed turn-ending command rides back to the model. Smaller than the pre-push budget on
// purpose: this one goes into a turn that is still running and still holds its whole transcript, so it needs
// enough to act on rather than the whole suite a push dialog quotes into a fresh session.
const TURN_RULE_OUTPUT_BYTES = 4_000;

/* The Claude Code harness — a native Claude turn's subscription OAuth (with its mid-turn refresh callback), or
 * the translator endpoint a routed provider rides. Credentials are resolved by harness-credentials.ts,
 * which the quick-model one-shot behind the landed-work messages reads too, so both authenticate identically;
 * its refusals are values, and this is where they become the refusal the composer's connect gate reads. */
export const planHarnessTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnPlan> => {
    /* THE TWO THINGS NOTHING ELSE HERE DEPENDS ON, together — a token refresh that may go to the network, and a
     * settings read. They used to be awaits in a row in front of every gate, which meant every turn paid both
     * end to end before the first byte of planning happened. Doing the settings read on a turn that then refuses
     * for its credential costs a file read nobody will use, which is the trade. */
    const [resolved, settings] = await Promise.all([
        services.perf.track("turn.plan.credentials", { provider: input.agent ?? "claude" }, () =>
            resolveHarnessCredentials(services, {
                agent: input.agent,
                ...(input.account !== undefined ? { account: input.account } : {}),
                ...(input.model !== undefined ? { model: input.model } : {}),
            }),
        ),
        // Per-sandbox agent toggles. stableSystemPrompt keeps the preset system prompt byte-stable so the
        // provider prompt cache survives the turn — the cross-provider delegation note then rides the user
        // message instead of the system prompt.
        context.settings === undefined
            ? services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get())
            : Promise.resolve(context.settings),
    ]);
    if (!resolved.ok) {
        return { ok: false, ...(resolved.code !== undefined ? { code: resolved.code } : {}), message: resolved.message };
    }
    const { oauthToken, refreshOauthToken, endpoint, allowance } = resolved.credentials;
    // Internal (intent-declared, from env) tools first, then external mcp-kind capabilities — a same-named
    // external tool overrides, matching mcpServersOf's last-wins merge.
    const tools = [...services.tools, ...mcpToolsOf(granted), ...hostToolsOf(granted, services.config.sandbox.port, services.hostBridgeToken)];
    const {
        stableSystemPrompt,
        hashlineEdits,
        iqSearch,
        iqContext,
        iqContextHoldout,
        outputCleaners,
        outputHoldout,
        terseOutput,
        terseHoldout,
        systemPromptMode,
        rules,
        subagentsAtOnce,
        subagentsPerTurn,
        subagentDepth,
        actionRules,
        commandRules,
        systemPrompt: customPrompt,
    } = settings;
    /* The rules armed where a turn ends. STANDING, not matching: their conditions are read at the Stop, when
     * the turn has actually edited something to narrow on (rules/turn-ending.ts). */
    const turnEndingRules = standing(rules, "turn.ending");
    /* THE TERSE EXPERIMENT'S COIN FLIP. The steer is eligible only where the daemon still appends to the
     * prompt — a custom prompt takes it away with everything else — and the holdout then runs its fraction of
     * eligible turns WITHOUT it, so the savings report has two populations of the same command stream to
     * compare instead of an assertion. A turn outside the experiment records no arm at all (see UsageTurn.terse):
     * "the steer was off for everyone" is not a control group. */
    const terseEligible = terseOutput && systemPromptMode !== "custom" && terseHoldout > 0;
    const terseArm = terseEligible ? Math.random() >= terseHoldout : undefined;
    /* Retrieval starts HERE and is awaited at the prompt, so its (deadline-capped) latency runs underneath the
     * gates below — the dependency probe, the delegation lookup, the browser servers — instead of on top of
     * them. `input.prompt` is the user's own words: `context.base.prompt` may already carry a switched
     * conversation's history preamble, whose opening lines would then be what got searched. */
    /* NOT FOR AN UNATTENDED TURN, whose prompt is not a question — it is a brief some surface composed (a loop
     * iteration, a chore, an acceptance story). Retrieval reads the opening 400 characters as its query, and
     * for those the opening is scaffolding: a loop's iteration heading and its "you are one iteration of a
     * loop" preamble were being searched against the index, and the ranked answer to THAT was pasted on top of
     * the step's real instructions. Every workflow step opened with a page of it.
     *
     * AND NOT FOR THE RESUME SENTENCE, which is the same failure one layer in: a turn re-run after a renewed
     * credential, a provider outage or a sandbox restart carries the daemon's own explanation of the
     * interruption in front of the prompt (turn-resume.ts), and 400 characters of that is the whole query. Six
     * turns in one week searched the index for "the Claude credential ... has been renewed" and pasted the
     * ranked answer to it over the question the user had actually asked. The words underneath are the ask.
     *
     * ONE NOTE PER CONVERSATION, AND ONLY WHERE A PERSON OPENED ONE BY TYPING — which is the rule the three
     * paragraphs above are special cases of, and the only rule that holds without a list of stopwords behind it.
     *
     * A week of real turns, scored on whether the agent then opened a file the note named: 75% on a
     * conversation's opening message against a 27% chance floor, 37% on every later message against 13% — and
     * the later ones mostly re-name files the conversation was already sitting in. The reason is structural. A
     * follow-up means what the turn above it meant, so "Yes, fix it.", "Next iteration." and "Done. Verify if
     * all is good." are questions to the index only if you cannot see that turn — and the index cannot. An
     * opening message is the one place where the words on screen carry the whole ask.
     *
     * The three clauses are that sentence, spelled: `unattended` drops everything a surface started (a loop
     * iteration, a chore, an acceptance story, and every automation wake — a schedule mints a FRESH conversation
     * on each fire, so nothing else here would tell it from a person opening one); `forkOf` drops a
     * conversation cut from another, whose opening message continues a transcript it was handed rather than
     * starting one; and a turn count of zero is what makes it once per conversation rather than once per
     * message — the registry counts every turn that ran, however it ended. */
    const conversationTurns =
        context.conversationTurns ?? (input.conversationId === undefined ? 0 : (services.agents.entry(input.conversationId)?.turns ?? 0));
    const contextEligible = iqContext && input.unattended !== true && input.forkOf === undefined && conversationTurns === 0;
    /* PRE-INJECTION'S OWN COIN FLIP, on the same terms as the terse steer's — a fraction of otherwise-eligible
     * turns run without the retrieved context so the two arms are populations of the same command stream.
     * Independent of the terse flip on purpose: two independent flips leave each experiment's other-arm turns
     * evenly spread, where a shared one would confound them into a single four-cell design nothing here reads.
     *
     * FLIPPED ONLY WHERE THE MECHANISM APPLIES, which is what makes the arms mean anything. An arm stamped onto
     * a turn retrieval was never going to run for puts the same dead weight in both populations, and the delta
     * it dilutes is already small — the experiment carried that flaw while every unattended and follow-up turn
     * was being stamped, and scoping retrieval to opening messages would have made the diluting majority the
     * whole ledger. What is left in the two arms now is turns the note could have ridden. */
    const contextArm = contextEligible && iqContextHoldout > 0 ? Math.random() >= iqContextHoldout : undefined;
    // Past the gate, the holdout arm is the only thing left that can take the note away.
    const contextNote =
        contextEligible && contextArm !== false
            ? retrieveTurnContext({ iq: services.iq, logger: services.logger }, withoutResumeNote(input.prompt))
            : undefined;
    /* THE SECOND ROUND, and the last of the planning I/O: an extension scan, the browser bring-up, and the
     * delegation lookup that reaches the translator. Only `delegation` waited on anything above it (it needs
     * `stableSystemPrompt`), which is why these could not join the round before it — and why they had no
     * business being three more awaits in a row. */
    /* WHICH PERSONA THIS TURN WEARS — resolved by planTurn, above the provider split, and arriving here already
     * applied to `granted`: an account this turn may not act through is not in that list, so it gets no MCP
     * server, no Chromium and no open profile. Absent rather than present-and-discouraged, which is the only
     * version of this that survives an agent misreading its instructions (personas/personas.ts holds the rule).
     *
     * The fallback is the open attended posture, for the one caller that builds a plan without a route behind it
     * (the bench). Nothing that starts a real session takes it: planTurn always resolves a card first. */
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    // The accounts this turn speaks for — one list feeding both the browser servers and the accounts tools'
    // scope, so a tool can never reach an account whose browser this turn was refused. Identities are
    // account-shaped here: the accounts tools address them by id too (typing the identity's email, fetching a
    // code from its mailbox, marking its provider login).
    const browserAccountIds = granted
        .filter((capability) => capability.kind === "browser" || capability.kind === "identity")
        .map((capability) => capability.id);
    const [extensionAgentDirs, browser, delegation] = await Promise.all([
        services.perf.track("turn.plan.extensions", {}, () => extensionAgentDirsOf(services)),
        // Each browser capability (account) grants the @playwright/mcp browser tools, bound to that account's
        // persisted profile so the agent acts as the signed-in owner (read/reply/comment/post/join) — or signs
        // the account in itself when it is still pending — filtered to the accounts this turn's persona
        // speaks for.
        services.perf.track("turn.plan.browser", {}, () => browserServersOf(granted, services.workspace.root, persona.powers.browser)),
        services.perf.track("turn.plan.delegation", {}, () => delegationEnv(services, stableSystemPrompt)),
    ]);
    // The image-baked iq plugin (skill + SessionStart nudge) loads ahead of any user-added plugin-kind
    // capabilities so the agent prefers iq for code search — gated by the per-sandbox iqSearch toggle (opt-in,
    // default off). Empty dir outside the container ⇒ skipped regardless. Extension checkouts with a
    // contributes.agent manifest entry ride the same SDK plugin loader.
    const plugins = [
        ...(services.config.iqPluginDir !== "" && (context.iqSearchEnabled ?? iqSearch) ? [services.config.iqPluginDir] : []),
        ...pluginDirsOf(granted, services.workspace.root),
        ...extensionAgentDirs,
    ];
    // Turn-scoped roots follow the effective cwd: hashline edits must anchor in the worktree an isolated turn
    // edits. Browser profiles, plugin checkouts, and attachments stay on /work — absolute-path inputs, not edit
    // targets.
    const dependencyTitle = input.conversationId === undefined ? input.title : services.agents.entry(input.conversationId)?.title;
    const sdkServers = {
        ...browser.servers,
        // hashlineEdits: swap the native Edit/Write (disabled below) for hash-anchored file tools.
        ...(hashlineEdits ? { hashline: createHashlineServer(context.localCwd) } : {}),
        // The `wait` tool: park until a child of this turn — a delegated CLI, an Agent-tool subagent — is
        // blocked on input or finished (subagent-wait.ts). Always offered — a turn that spawns nothing simply
        // never calls it — and settled by the turn's own signal when the user stops the turn under it.
        subagents: subagentWaitServer({
            conversationId: context.base.conversationId,
            signal: context.base.signal,
        }),
        /* Dependency readiness, asked rather than announced — and asked of the MAIN checkout, for the reason
         * planTurn sets out above: an isolated turn's dependencies live in /work and are only mounted into its
         * namespace, so /work's answer is the turn's answer and the worktree's would be an empty directory. */
        deps: createDepsServer({
            dependencies: services.dependencies,
            canInstall: persona.powers.files === "write" && persona.powers.shell,
            origin: {
                kind: "request",
                ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
                ...(dependencyTitle === undefined ? {} : { title: dependencyTitle }),
            },
        }),
    };
    const shellEnv = { ...context.cliEnv, ...delegation.env };
    // The turn's user message: attachment note folded in as before. With stableSystemPrompt on, the delegation
    // note is prepended HERE (a user-message preamble) instead of appended to the preset system prompt, so the
    // cached system+tools prefix stays byte-stable and the provider prompt cache is reused across the session.
    const promptWithAttachments =
        context.attachmentPaths.length > 0 ? withAttachmentNote(context.base.prompt, [...context.attachmentPaths]) : context.base.prompt;
    // Where this turn's instructions go — the owner's own system prompt (or the preset), what may be appended to
    // it, and whether the delegation note has to travel in the user message instead (system-prompt.ts owns all
    // three, because they are one decision).
    // Which persona the turn is wearing, said once in the instructions. Undefined when there is nothing to say —
    // an ordinary attended turn that named no persona is the status quo and needs no narration.
    const actingNote = personaNote(persona);
    const placement = turnPromptPlacement({
        mode: systemPromptMode,
        systemPrompt: customPrompt,
        ...(delegation.note !== undefined ? { note: delegation.note } : {}),
        stableSystemPrompt,
        // The arm decides when the experiment is running; the plain setting decides when it isn't.
        terseOutput: terseArm ?? terseOutput,
        ...(actingNote === undefined ? {} : { personaNote: actingNote }),
    });
    // A prompt whose leading `/` names no command this session has, which the CLI would otherwise answer with
    // "Unknown command" and discard — the note keeps the user's words in front of the model (agent-commands.ts
    // decides, turn-preamble.ts explains). Last of the notes, so it sits against the message it describes.
    const literalSlash = isUnknownSlashCommand(input.agent ?? "claude", promptWithAttachments);
    // withTurnPreamble so session restore can strip these notes back out of the stored message — they are
    // protocol, not something the user said (turn-preamble.ts).
    // The workspace context retrieved for this very message (turn-context.ts), if the flip gave this turn the
    // treatment arm and the retrieval found something worth prepending. Awaited here, where the notes are
    // assembled, so everything above ran while it was in flight.
    // The skip's REASON travels to the ledger, not just the fact of it: an arm that delivers on one turn in five
    // is either a gate working as designed or a deadline eating the feature, and the two call for opposite
    // responses. A boolean could not tell them apart, so the loss stayed unattributable for as long as it existed.
    const retrieved = await contextNote;
    const contextOutcome = retrieved === undefined ? undefined : "note" in retrieved ? "note" : retrieved.skipped;
    const contextDurationMs = retrieved?.durationMs;
    const prompt = withTurnPreamble(
        [
            ...(placement.userNote !== undefined ? [placement.userNote] : []),
            // After the standing protocol notes and before the slash note: those two are about how to read the
            // conversation, this is about the message itself, so it belongs against it.
            ...(retrieved !== undefined && "note" in retrieved ? [retrieved.note] : []),
            ...(literalSlash ? [LITERAL_SLASH_NOTE] : []),
        ],
        promptWithAttachments,
    );
    /* Fast speed is a NATIVE-turn ask, so it is held back here and handed only to the branch that keeps the
     * Anthropic credential. A routed turn (codex/grok/kimi/gemini/endpoint under this same loop) is pointed at
     * the sandbox's translator, and the harness refuses fast mode on anything that isn't first-party — so
     * forwarding it there would spend a control the turn cannot honour and report `not_first_party` for the
     * user to decipher. Split off the base rather than overridden below because the field's absence is the
     * whole meaning, and `fast: undefined` is not a thing this repo's tsconfig lets you write. */
    const { fast, ...routable } = context.base;
    return {
        ok: true,
        run: services.agent,
        ...(resolved.credentials.account !== undefined ? { account: resolved.credentials.account } : {}),
        ...(terseArm !== undefined ? { terseArm } : {}),
        ...(contextArm !== undefined ? { contextArm } : {}),
        ...(contextOutcome !== undefined ? { contextOutcome } : {}),
        ...(contextDurationMs !== undefined ? { contextDurationMs } : {}),
        request: {
            ...routable,
            prompt,
            // A routed turn (codex/grok under the Claude Code harness) pins the translator endpoint + bearer +
            // mapped model and withholds the Anthropic OAuth token (baseUrl in agent.ts drops
            // CLAUDE_CODE_OAUTH_TOKEN) — and, for the same reason, never carries the fast-mode ask. A native
            // Claude turn keeps its OAuth token, may go fast, and falls back to the daemon-wide default model
            // when the turn didn't pin one (a per-automation `model` already rode into `base` above and wins;
            // empty ⇒ subscription default).
            ...(endpoint !== undefined
                ? {
                      baseUrl: endpoint.baseUrl,
                      authToken: endpoint.authToken,
                      model: endpoint.model,
                      ...(allowance !== undefined ? { allowance } : {}),
                  }
                : {
                      ...(input.model === undefined && services.config.intenticAgentModel !== ""
                          ? { model: services.config.intenticAgentModel }
                          : {}),
                      ...(fast === true ? { fast } : {}),
                      ...(oauthToken !== undefined ? { oauthToken } : {}),
                      ...(refreshOauthToken !== undefined ? { refreshOauthToken } : {}),
                  }),
            ...(plugins.length > 0 ? { plugins } : {}),
            ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
            ...(tools.length > 0 ? { tools } : {}),
            ...(Object.keys(sdkServers).length > 0 ? { sdkServers } : {}),
            // The same directory the browser servers got as `--output-dir` — the hook that redirects model-named
            // screenshots into it needs the value too, and one source keeps them from drifting. Omitted when
            // the turn wired no browser servers (no Chromium in this image — the browser pack rides a rebuild):
            // its absence is what keeps the system prompt from advertising a browser that isn't there.
            ...(Object.keys(browser.servers).length > 0 ? { browserOutputDir: browserOutputDir(services.workspace.root) } : {}),
            // The debugging ports those same servers' Chromiums will open, so the first browser tool call can
            // register a session the owner can watch (browser/browser-sessions.ts).
            ...(Object.keys(browser.ports).length > 0 ? { browserPorts: browser.ports } : {}),
            // Each logged-in server's passkey store, so the observer that watches those pages also plugs the
            // platform's software security key into them (browser/passkeys.ts).
            ...(Object.keys(browser.passkeys).length > 0 ? { browserPasskeys: browser.passkeys } : {}),
            // The accounts tools ride whenever the turn has browser accounts — the account list is the very set
            // whose servers were just mounted (persona-filtered), which is the scope those tools enforce.
            ...(browserAccountIds.length > 0
                ? {
                      accountsServer: accountsServer({
                          capabilities: services.capabilities,
                          root: services.workspace.root,
                          accounts: browserAccountIds,
                          ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
                          attended: input.unattended !== true,
                          // The two verbs that reach past the narrow deps — filing a new account under an
                          // identity, and reading one code off its linked mailbox — injected as closures so
                          // the tools stay testable without Services or a network.
                          openAccount: (request) => openBrowserAccount(services, request),
                          fetchCode: fetchEmailCode,
                      }),
                  }
                : {}),
            // hashlineEdits owns file mutation via the hashline MCP server above, so drop the native Edit/Write
            // from the model's context (native Read stays for viewing images/PDFs).
            ...(hashlineEdits ? { disallowedTools: ["Edit", "Write"] } : {}),
            // Forward the Bash output-cleaner spec (default "off" ⇒ forwarded ⇒ filter disabled; "" ⇒ omit ⇒
            // filter's all-on default) and the holdout control fraction.
            ...(outputCleaners !== "" ? { outputCleaners } : {}),
            ...(outputHoldout > 0 ? { outputHoldout } : {}),
            // Every stored credential, masked out of every tool result — unconditional, because unlike the
            // cleaners this is not a saving that can be traded away (agent/agent-redaction.ts).
            secretValues: services.secretValues,
            ...(Object.keys(shellEnv).length > 0 ? { cliEnv: shellEnv } : {}),
            /* The delegation ceilings, forwarded ONLY WHERE THE OWNER MOVED ONE. An untouched cap is left for the
             * harness to answer, which is not the same as sending the number the harness would have picked: the
             * nesting cap is remote-config'd inside the CLI (its 3 is a fallback), so restating today's default
             * as an env var would quietly pin a value that is meant to be able to move. */
            ...(subagentsAtOnce !== SETTINGS_DEFAULTS.subagentsAtOnce ? { subagentsAtOnce } : {}),
            ...(subagentsPerTurn !== SETTINGS_DEFAULTS.subagentsPerTurn ? { subagentsPerTurn } : {}),
            ...(subagentDepth !== SETTINGS_DEFAULTS.subagentDepth ? { subagentDepth } : {}),
            /* The rules standing where a turn ends, forwarded only when there ARE some so a workspace with none
             * wires no hooks at all. Their CONDITIONS are deliberately not read here: this turn has not run
             * yet, so nothing knows which files it will touch, and a path condition resolved now would be a
             * condition that can never hold (rules/turn-ending.ts reads them at the Stop instead).
             *
             * The runner rides along beside them so a `command` rule has somewhere to run — in the turn's own
             * cwd, which under an isolated turn is the worktree the agent is actually editing. */
            ...(turnEndingRules.length > 0
                ? {
                      turnEndingRules,
                      /* A rule that spoke here CONTINUED a turn the model had finished, which is the answer to
                       * "why is this still going" and the one thing about this moment nobody can see from the
                       * outside. Stamped for the settings list and written to the feed, both best-effort: a
                       * turn must settle whether or not its bookkeeping did. */
                      onRuleFired: (rule: Rule) => {
                          void services.ruleFirings
                              .stamp(rule.id, Date.now())
                              .catch((error: unknown) => services.logger.warn({ err: error, rule: rule.id }, "rule firing stamp failed"));
                          void services.activity
                              .append({
                                  direction: "system",
                                  type: "rule.continued_turn",
                                  content: `"${rule.label}" asked for one more thing before this turn could finish.`,
                                  ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
                              })
                              .catch((error: unknown) => services.logger.warn({ err: error, rule: rule.id }, "rule activity append failed"));
                      },
                      runRuleCommand: (command: string, timeoutMs: number) =>
                          runRuleCommand(services, {
                              command,
                              timeoutMs,
                              cwd: context.localCwd,
                              session: CHECKS_SESSION,
                              window: "checks",
                              outputBytes: TURN_RULE_OUTPUT_BYTES,
                          }),
                  }
                : {}),
            // The sniffer's rulebook, forwarded only when the owner wrote a rule — same no-hook economy.
            ...(Object.keys(actionRules).length > 0 ? { actionRules } : {}),
            // The command gate's rulebook, on the same terms: no rule, no hook, and a workspace that has never
            // opened this pays nothing for it.
            ...(Object.keys(commandRules).length > 0 ? { commandRules } : {}),
            // Which base the prompt is built on, plus either the owner's own text (under "custom") or what to
            // append to a built-in base — never both, which is what turnPromptPlacement decided above.
            systemPromptMode,
            ...(placement.systemPrompt !== undefined ? { systemPrompt: placement.systemPrompt } : {}),
            ...(placement.systemAppend !== undefined ? { systemAppend: placement.systemAppend } : {}),
            // Mid-turn steering (the /agent/steer queue streamAgent registered) — Claude Code harness only.
            ...(context.steering !== undefined ? { steering: context.steering } : {}),
            // The rebase the cards take back while the user is answering them — isolated turns only.
            ...(context.resync !== undefined ? { resync: context.resync } : {}),
        },
    };
};

/* CROSS-PROVIDER DELEGATION VIA THE SHELL. When Codex is reachable, the agent's Bash gets the shared CODEX_HOME
 * (whose config.toml selects the translator subscription) plus the local bearer, and the system prompt a short
 * how-to note. Codex is reachable when the translator holds the ChatGPT subscription, or a dev OPENAI_API_KEY is
 * set; nothing ⇒ no env, no note — delegation isn't offered. The env and the note are one decision (an agent
 * told it may delegate but handed no credential is worse than one never told), so they are resolved together. */
const delegationEnv = async (
    services: Services,
    stableSystemPrompt: boolean,
): Promise<{ readonly env: Record<string, string>; readonly note?: string }> => {
    const translatorReady = services.config.translator.url !== "" && (await services.cliProxy.accounts()).codex.length > 0;
    const codexHome = translatorReady || services.config.openaiApiKey !== "" ? services.codexHome : undefined;
    const grokConnected = await services.openCode.connected("xai");
    /* The warm server's URL, which the note's `opencode run --attach` command points at so the delegated
     * session runs where the daemon's event stream can see it (grok/opencode.ts). Resolving it boots the
     * server when the boot warmup hasn't — the same cost the model lookup below already pays — and a boot
     * that fails withholds the Grok offer entirely: a command template pointing at a server that isn't
     * there is worse than no offer, and Grok turns are broken then anyway. */
    const openCodeUrl = grokConnected ? await services.openCode.url().catch(() => undefined) : undefined;
    // Resolve the xAI model the note names from xAI's live catalog (default, else first), so it never hardcodes a
    // since-renamed id. Tolerate a transient xAI blip — a Claude turn must not fail on this lookup; the note then
    // omits the model and tells the agent to list xAI's models itself. Skipped in stable mode, where the note
    // stays model-agnostic (it points the agent at `opencode models`) so no volatile id enters the turn at all.
    const grokModel =
        grokConnected && !stableSystemPrompt
            ? await services.openCode
                  .xaiModels()
                  .then((catalog) => catalog.default ?? catalog.models[0]?.id)
                  .catch(() => undefined)
            : undefined;
    const note = delegationNote({
        ...(codexHome !== undefined ? { codexHome } : {}),
        ...(openCodeUrl !== undefined ? { openCodeUrl } : {}),
        ...(grokModel !== undefined ? { grokModel } : {}),
    });
    return {
        env: {
            ...(codexHome !== undefined ? { CODEX_HOME: codexHome } : {}),
            // The translator provider (config.toml) reads the bearer from CODEX_API_KEY; the dev api-key path
            // uses the container's own OPENAI_API_KEY, already in the shell env.
            ...(translatorReady ? { CODEX_API_KEY: services.config.translator.token } : {}),
        },
        ...(note !== undefined ? { note } : {}),
    };
};

// Attachments ride as absolute paths on the request; every adapter takes them the same way and decides for
// itself whether they become native image inputs or a file list in the prompt.
const withAttachments = (request: AgentRequest, paths: readonly string[]): AgentRequest =>
    paths.length > 0 ? { ...request, attachments: [...paths] } : request;
