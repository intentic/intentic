import { createHash } from "node:crypto";
import { join } from "node:path";
import {
    type AgentCapabilities,
    type AgentEvent,
    type AgentTurn,
    type Capability,
    type Rule,
    type SandboxSettings,
    type SystemPromptMode,
    type TurnNote,
    SandboxSettingsSchema,
    capabilitiesOf,
    envSuffix,
} from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { type IsolationAnchor, fromWorktree, inWorktree, nsenterPrefix } from "../agents/isolation.js";
import { admitTurn, readMemoryHeadroom } from "../platform/memory-admission.js";
import { createFreshnessResolver } from "../dependencies/registry-freshness.js";
import { createWorkspacePins } from "../dependencies/workspace-pins.js";
import { statePath } from "../workspace/state-paths.js";
import { dirtyPathsAcross } from "../git/changes.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import { accountsServer } from "../browser/accounts-tools.js";
import { secretsServer } from "../browser/secrets-tools.js";
import type { SecretAccess } from "./agent-secrets.js";
import { fetchEmailCode } from "../browser/email-codes.js";
import { openBrowserAccount } from "../capabilities/open-account.js";
import { browserOutputDir } from "../browser/browser-artifacts.js";
import { browserServersOf } from "../browser/browser-tools.js";
import { personaKitPlugin, readPersonaPrompt } from "../personas/persona-kit.js";
import {
    type TurnPersona,
    personaCapabilities,
    personaCliEnv,
    personaDisallowedTools,
    personaNote,
    personaPrompt,
    turnPersona,
} from "../personas/personas.js";
import { personaScopeOf } from "../personas/persona-scope.js";
import { jsExecutionPlanOf } from "../execution/js-runtime.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { hostToolsOf } from "../capabilities/host-tools.js";
import { webextToolsOf } from "../capabilities/webext-tools.js";
import { mcpToolsOf } from "../capabilities/mcp-tools.js";
import { pluginDirsOf } from "../capabilities/plugin-dirs.js";
import type { Services } from "../composition.js";
import { extensionAgentDirsOf } from "../extensions/installed-extensions.js";
import { createHashlineServer } from "../hashline/hashline-tools.js";
import { createDiagnosticsServer } from "../logs/diagnostics-tools.js";
import { type RuleCommandRun, runRuleCommand } from "../rules/rule-command.js";
import { fileEditedReviewer, spawnEditCommand } from "../rules/file-edited.js";
import { verifyTestsMessage } from "./agent-tests.js";
import { passesAgainstHead } from "./agent-test-strength.js";
import { recordCheckVerdict } from "./turn-checks.js";
import { standing } from "../rules/rules.js";
import { turnEndingNote } from "../rules/turn-ending-note.js";
import { CHECKS_SESSION } from "../terminal/terminal-session.js";
import { queueRunEnabled } from "../terminal/terminal-run.js";
import type { AgentRequest } from "./agent.js";
import { armSupervisor, type ChildSupervisor } from "../children/children.js";
import { SPAWN_NOTE_TITLE, spawnNote } from "../children/spawn-note.js";
import { adapterFor } from "./adapter-registry.js";
import { isUnknownSlashCommand } from "./agent-commands.js";
import type { SteeringQueue } from "./agent-steering.js";
import { withAttachmentNote } from "./attachment-note.js";
import { contextShortfall } from "./context-budget.js";
import { subagentWaitServer } from "./subagent-wait.js";
import { watchServer } from "./watch-server.js";
import { resolveHarnessCredentials } from "./harness-credentials.js";
import { turnPromptPlacement } from "./system-prompt.js";
import { composeWirePrompt, LITERAL_SLASH_NOTE, worktreeNote, worktreeReminder } from "./turn-preamble.js";
import { WORKSPACE_MAP_NOTE_TITLE, workspaceMapNote } from "./workspace-map.js";
import { createDepsServer } from "../workspace/deps-tools.js";
import { dependencyDirForCommand } from "./agent-deps.js";
import { setupNoticeFor, setupNoticeTitle } from "../workspace/workspace-setup.js";
import { loadedSkillCatalogNote, SKILL_CATALOG_NOTE_TITLE } from "../settings/loaded-skills.js";
import { IQ_SEARCH_INSTRUCTION_TITLE, iqSearchInstruction } from "./iq-search-instruction.js";
import { explainCommand } from "./command-explainer.js";
import type { CommandGateOptions } from "../guard/command-gate.js";

/* WHICH RUNTIME SERVES A TURN, AND WHAT IT IS HANDED, the one question every turn has to answer before it can
 * stream anything, and the one the turn route used to answer inline as a four-arm if/else chain wrapped around
 * its own lifecycle bookkeeping.
 *
 * Each provider answers it the same four ways and differs only in the details: gate the credential, name the
 * runner, name the account the usage frames are attributed to, and assemble the request. Writing that out per
 * arm is what let the arms drift, the Codex gate resolved a concrete model so the CLI's built-in default could
 * never leak through, and the Grok gate learned the same lesson separately, months later.
 *
 * A REFUSAL IS A VALUE, exactly as in harness-credentials.ts (which this calls, and whose header explains why).
 * Every one is an ordinary state of a sandbox, a subscription nobody connected, an Agent capability that was
 * uninstalled, rather than an exception, and every one needs the USER. A session the runtime has forgotten used
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
          // The provider account serving this turn, the attribution key stamped onto the usage/rate-limit
          // frames and the activity log. Undefined when the credential came from the container env, or from a
          // translator subscription rather than an account this sandbox stores.
          readonly account?: string;
          // Which arm of the terse experiment this turn was built on, when it was in the experiment at all,
          // stamped onto the spend ledger at turn end (UsageTurn.terse) because that is the only record of it.
          // It rides the plan rather than the request: the request is what the SDK is handed, and the steer has
          // already been folded into the prompt by the time one exists.
          readonly terseArm?: boolean;
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
    // The tree as the DAEMON reaches it, what the daemon itself runs against the files (hashline edits, the
    // dependency probe) must use, because the daemon is not in the turn's namespace.
    readonly localCwd: string;
    // The workspace root as the AGENT sees it, what a session id is looked up against.
    readonly effectiveCwd: string;
    readonly cliEnv: Record<string, string>;
    // Mid-turn steering, present only where the runtime declares it (capabilitiesOf().steering, the Claude
    // Code loop's streaming input, and Pi's own steer queue).
    readonly steering: SteeringQueue | undefined;
    // Resolved once above the provider split. Optional only for focused callers that invoke an arm directly.
    readonly settings?: SandboxSettings;
    readonly conversationTurns?: number;
    readonly iqSearchEnabled?: boolean;
    readonly iqSearchNote?: string;
    // The generated name/description catalogue for a runtime without a native skill loader. Opening turn only;
    // the provider session carries it thereafter, like the workspace map and iq teaching.
    readonly skillCatalogNote?: string;
    // The `agents` CLI teaching for shell-only runtimes, resolved by planTurn on a conversation's opening turn
    // where the spawn door is open (children/spawn-note.ts). Rides the same notes list as the iq teaching.
    readonly spawnNote?: string;
    readonly iqSearchCohort?: string;
    /* Who the turn is and what it may do, resolved once by planTurn and handed down (personas/personas.ts).
     * Set only on the context the arms receive, the route builds this object before a card has been read, so
     * it is absent there and present everywhere it is used. */
    readonly persona?: TurnPersona;
    /* Re-take the pre-turn rebase while the turn is parked on a card (agent.routes.ts owns the git and the
     * bookkeeping; agent.ts picks the moments). Isolated turns only, a main-tree turn has no branch to move.
     *
     * Harness-only, like steering and for the same reason: the cards that park a turn long enough for the
     * main line to move are the harness's own (the `ask` tool, the plan gate). A native codex/grok/ACP turn
     * has no seam to call it from, so handing it one would be a field nothing reads. */
    readonly resync?: () => Promise<AgentEvent | undefined>;
    /* The child-agent supervision surface (children/children.ts childSupervisor), injected by agent.routes
     * like `resync` and for the same cycle reason: a child runs through streamAgent, which only the route can
     * hand down. Absent for a conversationless turn (a child needs a parent to file under) and for focused
     * callers with no route behind them; the tools are then not offered. */
    readonly children?: ChildSupervisor;
}

/* WHY EVERY STEP IN HERE IS MEASURED, and why they run together rather than one after another.
 *
 * Planning a turn is nothing but independent I/O, a capability listing, a dependency probe, a token refresh, a
 * settings read, a browser bring-up, a delegation lookup, and it was written as a chain of awaits, so a turn
 * paid the SUM of them. The daemon's own preflight marks (agent.routes.ts) recorded 5 to 22 seconds sitting
 * inside a single stage called `plan`, which is where the marks stopped: the one number anybody had said the
 * slow thing was "planning", and planning is a dozen things. Now each one files its own span, so the next slow
 * turn names the step instead of the phase, and because they overlap, the turn pays the SLOWEST rather than
 * the total. Nothing here reads anything else here, with two exceptions the harness arm spells out.
 */
/* THE PERMISSION CARD'S PLAIN-SENTENCE PASS, bound to this sandbox's accounts, or nothing at all.
 *
 * `undefined` when the owner left the setting off, and that absence is the whole economy of the feature: the
 * gate calls what it was handed, so a workspace that never opened the switch never reaches a quick model and
 * never pays for one. Nothing downstream needs a flag to check.
 *
 * A closure over `services` rather than the services themselves, because the seam it fills lives in guard/,
 * which is deliberately ignorant of accounts, chains and quotas (see CommandGateOptions.explain). */
const explainerFor = (services: Services, on: boolean): CommandGateOptions["explain"] =>
    on ? (program, language, signal) => explainCommand(services, program, language, signal) : undefined;

export const conversationExperimentArm = (conversationId: string | undefined, holdout: number): boolean => {
    if (conversationId === undefined) {
        return Math.random() >= holdout;
    }
    const bucket = createHash("sha256").update(`iq-search:${conversationId}`).digest().readUInt32BE(0) / 0x1_0000_0000;
    return bucket >= holdout;
};

/* A RULE'S COMMAND RUNS WHERE THE TURN DID, and for an isolated turn that means inside its namespace.
 *
 * Same hop the Bash tool's rewrite makes (agent-terminals.ts), for the same reason and by the same primitive.
 * Without it the check runs in the pane's own namespace, the daemon's, cwd'd at the worktree, where every
 * dependency tree is an empty directory: `pnpm lint` cannot find its own linter, `pnpm verify` cannot find a
 * type checker, and the gate reports a red tree that does not exist. `bash -c` with the whole command quoted,
 * because a rule's command is a SHELL LINE (`cd intentic && pnpm lint && pnpm verify`) and nsenter takes an
 * argv: handed over unquoted, everything after the first `&&` would run outside the namespace. */
export const ruleCommandIn = (command: string, anchor: IsolationAnchor | undefined): string =>
    anchor === undefined ? command : `${nsenterPrefix(anchor.pid, anchor.cwd)}bash -c ${shellQuote(command)}`;

export const planTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    /* CAPACITY BEFORE ANYTHING ELSE, and above the dispatch so it covers every provider arm rather than the
     * one that happens to be wired here. A box with nothing left cannot serve a Claude turn, a Codex turn or an
     * ACP turn, so asking which of them this is would only be asking a question whose answer does not matter.
     *
     * FIRST, so a refused turn costs nothing: the settings read, the capability list, the dependency probe and
     * the persona load below all run before any credential is checked, and every one of them is work done ON
     * the box that is already out of room. Three in-memory file reads is the whole price of not doing them.
     *
     * Uncapped sandboxes and daemons that cannot see a cgroup admit unconditionally — see admitTurn. */
    const admission = admitTurn(await readMemoryHeadroom(), context.base.unattended === true);
    if (!admission.admit) {
        return { ok: false, code: "sandbox-memory-low", message: admission.message };
    }
    // Harness (agentic loop) is orthogonal to provider: "native" runs each provider on its own runtime;
    // "claude-code" forces the Claude Code Agent SDK loop for ANY provider, codex/grok then fall through to the
    // harness plan below, which serves them by pointing the harness at the sandbox's translator. The pair's
    // declared record (capabilitiesOf) names the runtime, so the arm that serves a turn and the abilities the
    // rest of the daemon gates on can't disagree: both read the same row.
    const provider = input.agent ?? "claude";
    const harness = input.harness ?? "native";
    const capabilities = capabilitiesOf(provider, harness);
    /* WHAT THIS CONVERSATION HAS ALREADY BEEN TOLD, as the two facts the preamble's gates read: how many turns
     * have run in it, and whether one of them threw the model's context window away (PersistedAgent.compactedTurn).
     * Read together off one entry lookup, because every note that is said ONCE has to answer both, "is it already
     * in the history" and "is that history still there". */
    const entry = input.conversationId === undefined ? undefined : services.agents.entry(input.conversationId);
    const conversationTurns = entry?.turns ?? 0;
    // SETTINGS FIRST AND ALONE, one small local JSON read, resolved before the arms are dispatched to because
    // the composition of this turn's instructions reads it (honoured, below).
    const settings = context.settings ?? (await services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get()));
    const [installed, setup, cast, skillCatalogNote] = await Promise.all([
        // cli/mcp/plugin/browser/agent-kind capabilities, read once and shared by the arms that need them. NOT
        // the record above, these are what the OWNER installed, that is what the runtime can DO.
        services.perf.track("turn.plan.capabilities", {}, () => services.capabilities.list()),
        /* Dependency readiness, asked of the MAIN checkout, and this is the one place in the daemon where
         * "the tree this turn works in" is the wrong tree to ask about.
         *
         * An isolated turn's worktree carries no installed dependencies of its own. It gets them from the main
         * checkout: an overlay mount inside the turn's namespace, or a symlink at the same relative path when
         * the container cannot build one (agents/worktrees.ts). Both resolve THROUGH /work, so /work's answer
         * is the turn's answer. The daemon, however, stands outside that namespace, where the overlay is an
         * EMPTY DIRECTORY. So probing the worktree found the marker (the empty mount point), walked it, found
         * nothing in it, and reported every declared dependency in the workspace as not installed: on this
         * repository, 663 of them, in a paragraph telling the model its imports are only failing because an
         * install is behind. None of it was true, and it was stapled to the front of every isolated turn.
         *
         * Resolved HERE, ahead of the dispatch, because it is true of every runtime, see `honoured`. */
        // Full runtimes ask through the dependency server, and a native runtime needs the fallback notice only
        // when its provider session opens. Re-scanning the whole workspace for every follow-up merely to throw
        // the answer away was the CPU version of the context bloat this change removes.
        capabilities.mcp === "full" || context.base.sessionId !== undefined
            ? Promise.resolve([])
            : services.perf.track("turn.plan.deps", {}, () => services.dependencies.status()),
        // The cards themselves, one small JSON file, read unconditionally. Making the read conditional on
        // `actsAs` being set would skip exactly the case that matters most: an unattended wake that named
        // nothing, whose correct answer is "no accounts" and which must not reach one by saying nothing at all.
        services.perf.track("turn.plan.personas", {}, () => services.personas.list()),
        /* A native loader reads the canonical filesystem projection itself. Everything else gets the same
         * progressive-disclosure catalogue on the opening request, generated from THIS turn's tree and with
         * paths written as the agent sees them. It rides the user-message preamble rather than the system
         * append: Pi and ACP have no system seam, and a custom prompt must not make tools disappear. */
        capabilities.skillDiscovery === "prompt" && conversationTurns === 0
            ? services.perf.track("turn.plan.skills", {}, () => loadedSkillCatalogNote(context.localCwd, context.effectiveCwd))
            : Promise.resolve(undefined),
    ]);
    /* WHO THIS TURN IS AND WHAT IT MAY DO, resolved ABOVE the provider split, which is the whole reason this
     * moved here from the harness arm.
     *
     * It used to be resolved inside the Claude Code plan, so a native Codex, Grok, Pi or ACP session ignored the
     * card entirely: the same automation, pinned to the same read-only persona, was bounded on one runtime and
     * unbounded on another depending on a dropdown nobody associates with security. For an account filter that
     * was already wrong; for a toolbox it is the difference between a fence and a decoration.
     *
     * Every session start in the sandbox passes through this function, the chat, an automation wake, a Front Desk
     * message, a workflow step, a loop iteration, so this is the one place that can answer the question once
     * and have every surface inherit it. */
    const persona = turnPersona({ personas: cast, actsAs: input.actsAs, unattended: input.unattended === true });
    if (persona.reason === "unknown-persona") {
        // Worth a line of its own: the turn asked to act as somebody and this workspace has no such card, so it
        // is about to run with nothing at all and the prompt will read as though it should have had everything.
        services.logger.warn({ actsAs: input.actsAs }, "persona: no such card, this turn reaches no account and no tools");
    }
    /* The manifest as this turn may see it, narrowed ONCE and handed to every arm in place of the full list.
     * Filtering here rather than in each arm is what makes a shelf mean the same thing on every runtime, and
     * what keeps a capability kind added tomorrow from being quietly denied to everybody (personas.ts). */
    const granted = personaCapabilities(installed, persona);
    /* THE SPAWN DOOR, decided once here for every runtime, in both of its shapes. A persona with the delegate
     * shelf open AND full agency (shell and write — a child is a whole agent holding both) gets to start
     * agents on any connected provider; one without must not get them back by proxy. The TOOL mounts read this
     * same predicate at their seams (the harness arm's subagents server, Cursor's custom tools); the SHELL
     * door (`agents` CLI → /children routes) has no mount to gate, so the decision is recorded as the armed
     * closure itself (children/children.ts armSpawn), and the note below is only ever offered where the door
     * is actually open. */
    const maySpawn =
        context.children !== undefined &&
        input.conversationId !== undefined &&
        persona.powers.delegate &&
        persona.powers.shell &&
        persona.powers.files === "write";
    if (maySpawn && context.children !== undefined && input.conversationId !== undefined) {
        armSupervisor(input.conversationId, context.children);
    }
    /* The CLI teaching, for the runtimes whose only door is the shell: not the Claude Code loop (it carries
     * the spawn/wait MCP tools in its prompt) and not Cursor (same pair as custom tools), and only on the
     * conversation's opening turn, the iq teaching's rule — the provider session carries it thereafter. */
    const spawnNoteText =
        maySpawn && capabilities.runtime !== "claude-code" && capabilities.runtime !== "cursor" && conversationTurns === 0 ? spawnNote() : undefined;
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
    /* WHICH PROMPT THIS TURN RUNS ON once the card has had its say, the sandbox's, or this persona's instead
     * (personas.ts personaPrompt). The TEXT is read only where a card actually asked for its own, so an
     * ordinary turn pays nothing: `inherit` is the default and every card written before the field existed
     * means it. */
    const prompt = personaPrompt(
        persona.persona,
        persona.persona?.systemPromptMode === "custom" ? await readPersonaPrompt(services.workspace.root, persona.persona.id) : undefined,
        settings,
    );
    /* THE TERSE EXPERIMENT'S COIN FLIP, above the split with everything else about the instructions. The steer
     * is eligible wherever the daemon still adds to the prompt, a custom prompt takes it away with everything
     * else, and a runtime with no system seam never had it, and the holdout then runs its fraction of eligible
     * turns WITHOUT it, so the savings report has two populations of the same command stream to compare instead
     * of an assertion. A turn outside the experiment records no arm at all (see UsageTurn.terse): "the steer was
     * off for everyone" is not a control group.
     *
     * It reads the RESOLVED mode rather than the setting, so a persona that writes its own prompt takes the
     * steer away for its turns exactly as the sandbox-wide setting does, and a persona pinned to a built-in
     * base gets it back even where the sandbox is on a custom prompt. */
    const terseEligible = settings.terseOutput && prompt.mode !== "custom" && capabilities.instructions !== "none" && settings.terseHoldout > 0;
    const terseArm = terseEligible ? Math.random() >= settings.terseHoldout : undefined;
    const shared: TurnContext = {
        ...context,
        settings,
        conversationTurns,
        iqSearchEnabled,
        ...(iqSearchNote !== undefined ? { iqSearchNote } : {}),
        ...(skillCatalogNote !== undefined ? { skillCatalogNote } : {}),
        ...(teaching !== undefined ? { iqSearchCohort: teaching.cohort } : {}),
        ...(spawnNoteText !== undefined ? { spawnNote: spawnNoteText } : {}),
    };
    /* WHO GETS THE PROJECT MAP: the opening message of a conversation, once, and never again in it.
     *
     * ONCE, because the map is already in the transcript by the second turn and the layout has not moved since,
     * paying for it again would be the repetition that turns a note written to be read once into context bloat,
     * which is the mistake the dependency notice already had to be walked back from.
     *
     * NOT A FORK, whose opening message continues a transcript it was handed rather than starting one; the map
     * it inherited is the map it needs.
     *
     * UNATTENDED TURNS DO GET IT, which is where this parts company with the retrieved-context note above. That
     * one searches for the WORDS of the message, and an automation's brief is scaffolding that searches badly.
     * This one answers a question that does not depend on the words at all, what is this project and where am I
     * standing in it, and an unattended wake is precisely the run with nobody around to answer it. A schedule
     * mints a fresh conversation on every fire, so this is its only turn. */
    const workspaceMapEligible = settings.workspaceMap && input.forkOf === undefined && conversationTurns === 0;
    /* WHO GETS TOLD THAT THE CHECKS AT THE END OF A TURN RUN THEMSELVES: the opening message, and the turn after
     * a compaction. Not every turn, which is what this used to be.
     *
     * ONCE, for the reason the map above is once: by the second message the note stands in the session's own
     * history, the model can read it there, and sending it again bought nothing while costing a fraction of a
     * turn's context per turn, forever. That is the same repetition the dependency notice and the rebase note
     * were both walked back from, and a conversation pays for it in proportion to its own length.
     *
     * AND AGAIN AFTER A COMPACTION, which is the one event that makes "it is already in the history" false: the
     * messages this note rode in on are summarized away, and what is lost is an instruction the model has to
     * ACT on, don't run `pnpm verify` yourself, the daemon runs it when you stop. A turn that has forgotten it
     * spends minutes re-running the suite the Stop hook is about to run anyway. `>=` rather than `===` because
     * the read is one turn behind the write: a compaction is filed under the turn it happened in
     * (agents-registry's `compact` case), and it is the NEXT turn that has to say the note again, so a turn
     * whose count did not advance (an ending that ran no turn at all) errs toward telling the model twice
     * rather than never.
     *
     * NOT A FORK's opening message, for the map's reason: it continues a transcript that already carries this. */
    const turnEndingEligible =
        (conversationTurns === 0 && input.forkOf === undefined) || (entry?.compactedTurn !== undefined && entry.compactedTurn >= conversationTurns - 1);
    const planned: TurnContext = {
        ...shared,
        base: honoured(services, shared, capabilities, setupNoticeFor(setup), persona, installed, terseArm, prompt, {
            map: workspaceMapEligible,
            turnEnding: turnEndingEligible,
        }),
        persona,
    };
    /* CAN THE MODEL HOLD THIS TURN AT ALL, the last gate before an arm is asked to build a request, and the only
     * one that reads what was composed rather than what is connected (agent/context-budget.ts).
     *
     * HERE, not in an arm, for the reason every other pre-dispatch check is here: the question is about the pair
     * (this runtime's fixed cost, this model's window) and neither half belongs to a provider arm. And AFTER
     * `planned`, because the thing being measured is the prompt as it will be SENT, notes and all, which is what
     * `honoured` has just finished assembling. */
    const shortfall = await contextShortfall(services, {
        provider,
        runtime: capabilities.runtime,
        ...(input.model !== undefined ? { model: input.model } : { model: undefined }),
        // The prompt as it will be SENT, notes and all: the same serialization dispatch performs.
        prompt: composeWirePrompt(planned.base.notes ?? [], planned.base.prompt),
    });
    if (shortfall !== undefined) {
        services.logger.warn(
            { provider, model: input.model, window: shortfall.window, needed: shortfall.needed },
            "context: the model's window cannot hold a turn of this loop, refused before sending",
        );
        return { ok: false, code: "context-window-too-small", message: shortfall.message };
    }
    // The dispatch, through the registry rather than an if/else chain over the same union, so the set of
    // runtimes has one declaration, and the health probe the picker reads is written next to the arm it
    // predicts (see agent/adapter-registry.ts).
    const plan = await adapterFor(provider, harness).preflight(services, input, planned, granted);
    if (!plan.ok) {
        return plan;
    }
    return {
        ...plan,
        // Both arms are stamped HERE now, on the one path that flips them, the harness arm used to report the
        // terse one because it was the only arm that ran the experiment, which was the bug rather than the design.
        ...(terseArm !== undefined ? { terseArm } : {}),
        ...(searchArm !== undefined ? { searchArm, ...(teaching !== undefined ? { searchCohort: teaching.cohort } : {}) } : {}),
    };
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
 * The full explanation opens a provider session; later turns repeat only the short invariant, which survives
 * compaction without filling the session history with copies of the same paragraph.
 *
 * The SYNC note is here rather than in an arm because it is true of every runtime: the pre-turn rebase moved
 * the files under whichever model is about to read them (agents/sync.ts). This is the one point all four arms
 * pass through, so it is the only place a note can be added without being silently absent from three of them;
 * the harness arm appends its own note to the same typed list, and dispatch serializes the whole list once
 * (turn-preamble.ts, composeWirePrompt).
 *
 * THE DEPENDENCY NOTICE IS HERE FOR EXACTLY THAT REASON, having spent its life in the harness arm where three
 * runtimes could not see it. It is the one fact a turn cannot deduce and will otherwise be misled by, that an
 * import failing to resolve right now is the install being behind, not the code being wrong, and a Codex or
 * Grok session without it reads a wall of true-looking errors and starts editing correct source to satisfy
 * them. It also made the same request arrive as two different messages depending on who was serving it, which
 * is fatal to the one thing a workflow of two models exists to measure: run the same brief on Claude and on
 * Codex and the only difference must be the model. Rides the USER message, never systemAppend: it changes the
 * moment an install finishes, and the system prefix is kept byte-stable for the prompt cache.
 *
 * THE PERSONA'S SHELVES ARE APPLIED HERE FOR THE SAME REASON THE DEPENDENCY NOTICE IS. A bound that holds on one
 * runtime and not on the other three is not a bound; this is the single point all of them pass through, so the
 * connectors whose credentials are withheld and the tools taken out of the turn are the same set whoever serves
 * it. What CANNOT be applied here is anything capability-shaped that an arm builds for itself, those are
 * filtered upstream, out of the manifest each arm is handed (personaCapabilities).
 *
 * AND SO ARE THE TURN'S STANDING INSTRUCTIONS, which is the last thing that lived in one arm and read as
 * everyone's. The owner's system prompt was a Claude Code setting wearing a sandbox setting's name, a turn on
 * native Codex, Grok, Gemini, Pi or ACP ran without it and said so nowhere, and the persona note went with it,
 * so the sentence naming which accounts a session may speak through reached exactly one of six runtimes. What
 * each will accept is a declared axis now (AgentCapabilities.instructions) and system-prompt.ts composes to it;
 * this is the point that hands it to all of them. */
const honoured = (
    services: Services,
    context: TurnContext,
    capabilities: AgentCapabilities,
    setupNotice: string | undefined,
    persona: TurnPersona,
    // The UNFILTERED manifest, this needs to know which connectors exist in order to know whose credentials to
    // withhold, which the already-filtered list by definition cannot say.
    installed: readonly Capability[],
    // Which arm of the terse experiment this turn drew, when it is in the experiment at all. Undefined ⇒ no
    // experiment, and the plain setting decides.
    terseArm: boolean | undefined,
    // Which system prompt this turn runs on, with the persona's answer already resolved against the sandbox's
    // (personas.ts personaPrompt).
    prompt: { readonly mode: SystemPromptMode; readonly systemPrompt: string },
    /* WHICH SAY-IT-ONCE NOTES THIS TURN IS THE ONE TO SEND. Decided by the caller because the gates read `input`
     * and the conversation's entry (a fork's opening message, the turn count, the last compaction); spent HERE
     * because this is the only place that knows where the run starts, the card's own folder is resolved a few
     * lines down, and mapping /work for a run that begins inside one project is the failure the map is written
     * against. One record rather than a row of booleans: two positional flags of the same type, side by side,
     * is a swap that would typecheck. */
    send: { readonly map: boolean; readonly turnEnding: boolean },
): AgentRequest => {
    const { permissionMode, effort, fast, cliEnv, disallowedTools, ...rest } = context.base;
    // An isolated conversation's worktree is not the workspace root; a main-tree turn has nothing to say.
    const isolated = context.localCwd !== services.workspace.root;
    /* WHAT THIS TURN IS TOLD BEFORE THE USER SAYS ANYTHING, and where each piece of it can go on the runtime
     * that is about to serve it (system-prompt.ts owns both halves, because they are one decision). Undefined
     * settings is the focused caller that builds a plan without a route behind it (the bench); it gets the
     * schema's own defaults rather than a second list of them here. */
    const settings = context.settings ?? SETTINGS_DEFAULTS;
    // Which persona the turn is wearing, said once in the instructions. Undefined when there is nothing to say,
    // an ordinary attended turn that named no persona is the status quo and needs no narration.
    const actingNote = personaNote(persona);
    const placement = turnPromptPlacement({
        capabilities,
        ...prompt,
        stableSystemPrompt: settings.stableSystemPrompt,
        // The arm decides when the experiment is running; the plain setting decides when it isn't.
        terseOutput: terseArm ?? settings.terseOutput,
        ...(actingNote === undefined ? {} : { personaNote: actingNote }),
    });
    /* WHERE THE CARD SAYS TO STAND, a folder under the turn's own root, which is the worktree for an isolated
     * turn and the workspace for a shared one, so "start in this repo" means the same thing either way.
     *
     * Resolved through the workspace escape guard, and a path that fails it is DROPPED rather than refused: the
     * card is committed config a person hand-edits, and the honest failure for a typo'd folder is a session
     * that opens at the workspace root, not one that will not start at all, at 3am, for a job whose actual
     * work was never going to touch that folder anyway. */
    const startIn = persona.workspace?.startIn;
    const startPath = startIn === undefined || startIn === "" ? undefined : resolveWithin(context.effectiveCwd, startIn);
    /* THE SAME STARTING POSITION, AS THE DAEMON REACHES IT. `startPath` is the path the AGENT will be handed,
     * which for an isolated turn is a namespace address the daemon is not inside; anything the daemon must read
     * off disk has to go through `localCwd` instead (the same split hashline edits and the dependency probe
     * make). The map is walked here, so it takes this one.
     *
     * The ROOT moves with it, and that is the point rather than an accident: an isolated conversation's world IS
     * its worktree, so the "what else is in this workspace" line must name that tree's neighbours and not the
     * shared checkout's. */
    const mapRoot = isolated ? context.localCwd : services.workspace.root;
    const mapCwd = startIn === undefined || startIn === "" ? mapRoot : resolveWithin(mapRoot, startIn);
    /* THE PROJECT MAP, on the opening message of a conversation and nowhere else (workspace-map.ts). Placed in
     * this list rather than in the harness arm's for the same reason the dependency notice is: it is a fact
     * about the FILESYSTEM, so it is as true of a Codex or Grok turn as of a Claude one, and this is the single
     * point all six runtimes pass through.
     *
     * Read as an ordering: who you are, where your files are, what this project looks like, then what is wrong
     * with it (the dependency notice), general to specific, each note answering a question the one before it
     * raises. `mapCwd` outside the root is dropped by the escape guard, and a dropped start folder maps the root
     * exactly as it opens the session there. */
    const mapNote = send.map && mapCwd !== undefined ? workspaceMapNote({ root: mapRoot, cwd: mapCwd }) : undefined;
    const notes: TurnNote[] = [
        // First of the preamble, when there is one at all: a note that says who the turn is acting as belongs
        // ahead of anything about the files or the tools it is about to use.
        ...(placement.userNotes ?? []),
        ...(isolated && capabilities.isolation === "cwd"
            ? [
                  context.base.sessionId === undefined
                      ? worktreeNote(context.localCwd, services.workspace.root)
                      : worktreeReminder(services.workspace.root),
              ]
            : []),
        ...(mapNote === undefined ? [] : [{ title: WORKSPACE_MAP_NOTE_TITLE, text: mapNote }]),
        ...(context.skillCatalogNote === undefined ? [] : [{ title: SKILL_CATALOG_NOTE_TITLE, text: context.skillCatalogNote }]),
        /* THE DEPENDENCY NOTICE IS NOW THE FALLBACK RATHER THAN THE MECHANISM, and only for the runtimes that
         * have no mechanism to fall back FROM.
         *
         * A `full` runtime is handed the readiness tools and the two notices that fire on a real failure, a
         * post-edit type-check and a post-command miss (agent-deps.ts), and every one of those addresses the
         * turn that actually went near a drifted project. Pushing the paragraph as well would be paying for the
         * same three facts on every turn in the conversation, whether or not it ever touched one; it is the
         * repetition, not the wording, that made a sentence written to be read once into context bloat.
         *
         * The other runtimes get neither tools nor hooks, there is no seam in them to put either through, so
         * for those the paragraph is still the only thing standing between a model and a wall of true-looking
         * unresolved-import errors. It stays where it is, unchanged, for exactly as long as that is true. */
        ...(setupNotice !== undefined && capabilities.mcp !== "full" ? [{ title: setupNoticeTitle(setupNotice), text: setupNotice }] : []),
        ...(context.iqSearchNote !== undefined ? [{ title: IQ_SEARCH_INSTRUCTION_TITLE, text: context.iqSearchNote }] : []),
        ...(context.spawnNote !== undefined ? [{ title: SPAWN_NOTE_TITLE, text: context.spawnNote }] : []),
        /* Only the Claude Code loop executes command rules at Stop. Native runtimes must not be promised a
         * check their fallback path does not run. Said on the turns that cannot already read it in their own
         * history, which is the opening message and the first turn past a compaction (see `send.turnEnding`). */
        ...(capabilities.runtime === "claude-code" && send.turnEnding ? [turnEndingNote(settings.rules)].filter((note) => note !== undefined) : []),
    ];
    // The connectors this card did not grant, taken out of the shell's environment rather than left in it with
    // an instruction not to look. The manifest is read from the context's own base, which is the unfiltered
    // list, the filtered one is what the ARMS get, and this is the same decision applied to the environment.
    const shellEnv = cliEnv === undefined ? undefined : personaCliEnv(cliEnv, installed, persona, envSuffix);
    // The shelves that are not capability-shaped, as tool names the runtime knows. Concatenated with whatever
    // the request already carried (the hashline swap sets its own) rather than replacing it.
    const denied = [...(disallowedTools ?? []), ...personaDisallowedTools(persona, installed)];
    const dependencyDir = startIn ?? "";
    const dependencyInstallAllowed = persona.powers.files === "write" && persona.powers.shell;
    /* THE JS EXECUTION BACKEND'S PLAN, resolved here because this is the point where the persona, the turn's
     * tree and the filtered environment are all in hand at once, the same reason the shelves are applied here.
     * Gated on the runtime actually hosting the backend (AgentCapabilities.execution), so an adapter only ever
     * reads a request it fully honours; gated on the card inside jsExecutionPlanOf, so an ungranted backend is
     * absent from the request rather than present-and-refused. Its environment is the same filtered one the
     * shell gets, a script must not read a credential the command line could not. */
    const jsExecution = capabilities.execution.includes("js")
        ? jsExecutionPlanOf(persona, { root: context.effectiveCwd, cwd: startPath ?? context.base.cwd }, { ...shellEnv })
        : undefined;
    /* The folder limit and the sandbox switch, carried on the request for the runtime that can enforce them.
     * The folders resolve against the workspace root rather than `startPath`, the card spells them
     * workspace-relative, and a persona that starts in one repo while being allowed to read a sibling is an
     * ordinary answer that anchoring them to the start folder would make unsayable. */
    const scope = personaScopeOf(persona, context.effectiveCwd);
    return {
        ...rest,
        /* The prompt stays the user's own words; the notes ride TYPED beside them and are serialized into the
         * wire string exactly once, at dispatch (agent.routes.ts, composeWirePrompt). Stapling here is what
         * used to make everything downstream re-parse the string apart: the literal-slash guard read the
         * composed prompt and never saw the user's leading `/`, and the transcript record parsed a prompt the
         * notes were never in and silently dropped them (turn-preamble.ts tells the whole story). */
        notes,
        /* The composed instructions, carried on the request every runtime reads rather than on the one that
         * used to. Which of the two fields is set is the runtime's own answer (AgentCapabilities.instructions):
         * a replacement where one may be sent, an addition where only that is possible, neither where there is
         * no system seam, and the adapters below hand whichever arrived to their own provider. */
        systemPromptMode: prompt.mode,
        ...(placement.systemPrompt !== undefined ? { systemPrompt: placement.systemPrompt } : {}),
        ...(placement.systemAppend !== undefined ? { systemAppend: placement.systemAppend } : {}),
        /* HOW THIS RUNTIME CAN ENFORCE THE OWNER'S COMMAND RULEBOOK, from the pair's own record rather than
         * hardcoded in each adapter, which is what makes the axis ENFORCED rather than merely described: the
         * vendor runtimes derive their gate's shape from this value (guard/turn-gate.ts), so a row that lies
         * about itself changes how a turn behaves instead of only what the composer says about it. */
        rulebook: capabilities.rulebook,
        // Set HERE because this is the one point every runtime passes through, and because it is the only place
        // that can still tell the workspace root from the turn's cwd, below this, a persona's start folder and
        // an isolated worktree have already overwritten it.
        workspaceRoot: services.workspace.root,
        dependencyIssue: (command) => services.dependencies.issueAt(dependencyDirForCommand(dependencyDir, services.workspace.root, command)),
        dependencyInstallAllowed,
        /* The registry check on a version about to be pinned. Bound HERE, like the dependency answer above
         * it, because this is the last point that still knows the workspace root: the resolver's between-turn
         * cache lives beside the other derived state, and below this a persona's start folder or an isolated
         * worktree has already overwritten the root it would be keyed to.
         *
         * A resolver is built even when the setting is off. It holds no connection and opens nothing until it
         * is asked, and the hook that would ask it is not wired at all in that case (agent.ts), so the cost of
         * building one unconditionally is an object, while the cost of branching here would be a second place
         * that has to agree with agent.ts about what "off" means. */
        dependencyFreshness: settings.dependencyFreshness,
        freshnessResolver: createFreshnessResolver({ cacheDir: statePath(services.workspace.root, ".intentic/local/cache/", "freshness") }),
        // Lazy: the tree is walked on the first pin a turn actually sees, and never on a turn that touches no
        // manifest, so building this eagerly here costs nothing.
        workspacePins: createWorkspacePins(services.workspace.root),
        ...(startPath !== undefined ? { cwd: startPath } : {}),
        ...(scope !== undefined ? { personaScope: scope } : {}),
        ...(shellEnv !== undefined && Object.keys(shellEnv).length > 0 ? { cliEnv: shellEnv } : {}),
        ...(jsExecution !== undefined ? { jsExecution } : {}),
        ...(denied.length > 0 ? { disallowedTools: denied } : {}),
        // A "plan" runtime knows two postures: propose-then-approve, or run. Every other mode names the second
        // one, so it travels as the absence it already meant.
        ...(permissionMode !== undefined && (capabilities.permissions === "modes" || permissionMode === "plan") ? { permissionMode } : {}),
        ...(effort !== undefined && capabilities.effort ? { effort } : {}),
        // Fast speed, for the runtimes that can ask for it, the Claude Code loop alone. The second half of the
        // rule (a routed turn's endpoint is not first-party, so the harness would refuse) is applied where the
        // endpoint is chosen, in planHarnessTurn: this record is a pure function of (provider, harness) and
        // cannot see a credential.
        ...(fast === true && capabilities.fastMode ? { fast } : {}),
    };
};

/* THE PROVIDER ARMS LIVE WITH THEIR PROVIDERS NOW. planCodexTurn, planGrokTurn, planCursorTurn and
 * planGeminiTurn each sit in their provider's directory beside the adapter row that points at them
 * (`<provider>/<provider>-provider.ts`, aggregated by agent/provider-registry.ts); planAcpTurn and planPiTurn
 * sit beside their runtimes (acp/acp-adapter.ts, pi/pi-adapter.ts). What stays here is what serves EVERY
 * provider: planTurn's dispatch, and planHarnessTurn below — the Claude Code loop's arm, which no provider may
 * own because it also serves Kimi, the routed subscriptions and every endpoint capability. */

/* WHAT AN UNTOUCHED SETTING LOOKS LIKE, so a cap the owner never moved can be told from one they set to the
 * same number, the difference decides whether the harness is handed an env var at all (see the subagent caps
 * below). Read off the schema rather than restated here: two lists of defaults would be one list of defaults
 * and one list of stale numbers. */
const SETTINGS_DEFAULTS = SandboxSettingsSchema.parse({});

// How much of a failed turn-ending command rides back to the model. Smaller than the pre-push budget on
// purpose: this one goes into a turn that is still running and still holds its whole transcript, so it needs
// enough to act on rather than the whole suite a push dialog quotes into a fresh session.
const TURN_RULE_OUTPUT_BYTES = 4_000;

/* The Claude Code harness, a native Claude turn's subscription OAuth (with its mid-turn refresh callback), or
 * the translator endpoint a routed provider rides. Credentials are resolved by harness-credentials.ts,
 * which the quick-model one-shot behind the landed-work messages reads too, so both authenticate identically;
 * its refusals are values, and this is where they become the refusal the composer's connect gate reads. */
export const planHarnessTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnPlan> => {
    /* THE TWO THINGS NOTHING ELSE HERE DEPENDS ON, together, a token refresh that may go to the network, and a
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
        // provider prompt cache survives the turn.
        context.settings === undefined
            ? services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get())
            : Promise.resolve(context.settings),
    ]);
    if (!resolved.ok) {
        return { ok: false, ...(resolved.code !== undefined ? { code: resolved.code } : {}), message: resolved.message };
    }
    const { oauthToken, refreshOauthToken, endpoint, allowance, trial } = resolved.credentials;
    // Internal (intent-declared, from env) tools first, then external mcp-kind capabilities, a same-named
    // external tool overrides, matching mcpServersOf's last-wins merge.
    const tools = [
        ...services.tools,
        ...mcpToolsOf(granted),
        ...hostToolsOf(granted, services.config.sandbox.port, services.hostBridgeToken),
        ...webextToolsOf(granted, services.config.sandbox.port, services.webextBridgeToken),
    ];
    const {
        hashlineEdits,
        iqSearch,
        outputCleaners,
        outputHoldout,
        rules,
        subagentsAtOnce,
        subagentsPerTurn,
        subagentDepth,
        actionRules,
        commandRules,
        explainCommands,
    } = settings;
    /* The rules armed where a turn ends. STANDING, not matching: their conditions are read at the Stop, when
     * the turn has actually edited something to narrow on (rules/turn-ending.ts). */
    const turnEndingRules = standing(rules, "turn.ending");
    // The rules armed on every file the turn writes, run beside the type check (rules/file-edited.ts).
    const fileEditedRules = standing(rules, "file.edited");
    /* THE SECOND ROUND, and the last of the planning I/O: an extension scan and the browser bring-up, which
     * had no business being more awaits in a row. */
    /* WHICH PERSONA THIS TURN WEARS, resolved by planTurn, above the provider split, and arriving here already
     * applied to `granted`: an account this turn may not act through is not in that list, so it gets no MCP
     * server, no Chromium and no open profile. Absent rather than present-and-discouraged, which is the only
     * version of this that survives an agent misreading its instructions (personas/personas.ts holds the rule).
     *
     * The fallback is the open attended posture, for the one caller that builds a plan without a route behind it
     * (the bench). Nothing that starts a real session takes it: planTurn always resolves a card first. */
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    // The accounts this turn speaks for, one list feeding both the browser servers and the accounts tools'
    // scope, so a tool can never reach an account whose browser this turn was refused. Identities are
    // account-shaped here: the accounts tools address them by id too (typing the identity's email, fetching a
    // code from its mailbox, marking its provider login).
    const browserAccountIds = granted
        .filter((capability) => capability.kind === "browser" || capability.kind === "identity")
        .map((capability) => capability.id);
    const [extensionAgentDirs, browser, personaKit] = await Promise.all([
        services.perf.track("turn.plan.extensions", {}, () => extensionAgentDirsOf(services)),
        // The browser capabilities (accounts) grant the ONE routed @playwright/mcp server, each call bound by
        // its `account` argument to that account's persisted profile so the agent acts as the signed-in owner
        // (read/reply/comment/post/join), or signs the account in itself when it is still pending, filtered
        // to the accounts this turn's persona speaks for.
        services.perf.track("turn.plan.browser", {}, () =>
            browserServersOf(granted, services.workspace.root, persona.powers.browser, input.conversationId),
        ),
        // The card's own folder, when it has one, its skills, its subagents, its tools. Read as a plugin dir
        // below, which is what makes them native rather than something this daemon has to project anywhere
        // (personas/persona-kit.ts). Undefined for an unpinned turn and for a card nobody has written a kit for.
        persona.persona === undefined ? Promise.resolve(undefined) : personaKitPlugin(services.workspace.root, persona.persona.id),
    ]);
    // The image-baked iq plugin (skill + SessionStart nudge) loads ahead of any user-added plugin-kind
    // capabilities so the agent prefers iq for code search, gated by the per-sandbox iqSearch toggle (opt-in,
    // default off). Empty dir outside the container ⇒ skipped regardless. Extension checkouts with a
    // contributes.agent manifest entry ride the same SDK plugin loader.
    /* Resolved ONCE and read twice: the plugin list below, and the request's `iqAvailable`, which is what lets
     * the empty-search notice name iq only where its skill is actually loaded (agent/agent-search.ts). Deriving
     * it a second time at the hook would be the same condition written twice, and the holdout arm is exactly the
     * kind of thing that survives one copy of a condition and not the other. */
    const iqLoaded = services.config.iqPluginDir !== "" && (context.iqSearchEnabled ?? iqSearch);
    const plugins = [
        ...(iqLoaded ? [services.config.iqPluginDir] : []),
        // The webq plugin rides ungated: the CLI is baked onto PATH unconditionally, and the skill is what
        // keeps an agent from WebFetch-looping a JS-rendered docs site it could read in one webq call.
        ...(services.config.webqPluginDir !== "" ? [services.config.webqPluginDir] : []),
        ...pluginDirsOf(granted, services.workspace.root),
        ...extensionAgentDirs,
        /* LAST, after the sandbox-wide plugins, because it is the most specific thing this turn carries, the
         * card the session is actually wearing. The loader namespaces each plugin's skills by its plugin name,
         * so this is an ordering rather than an override: a kit skill and a workspace skill of the same name
         * are two skills, and the agent is told whose each one is. */
        ...(personaKit === undefined ? [] : [personaKit]),
    ];
    // Turn-scoped roots follow the effective cwd: hashline edits must anchor in the worktree an isolated turn
    // edits. Browser profiles, plugin checkouts, and attachments stay on /work, absolute-path inputs, not edit
    // targets.
    const dependencyTitle = input.conversationId === undefined ? input.title : services.agents.entry(input.conversationId)?.title;
    /* The one object behind every secret seam this turn gets: the named registry (masking reads it, the exits
     * resolve against it) and the use ledger those exits feed. `used` is fire-and-forget by design, a ledger
     * write must never fail or slow the tool call that spent the secret. */
    const secretAccess: SecretAccess = {
        list: services.secretRegistry,
        used: (use) => {
            void services.secretUses
                .record({ ...use, at: Date.now() })
                .catch((error: unknown) => services.logger.warn({ err: error, secret: use.name }, "secret use record failed"));
        },
    };
    const sdkServers = {
        ...browser.servers,
        /* The browser exit for stored secrets (browser/secrets-tools.ts): type a named value into the focused
         * field of a live page. Mounted only when the turn drives a browser at all, the tool's scope IS the
         * turn's browser list: the routed accounts, plus `web` when the credential-free browser is up. */
        ...(Object.keys(browser.servers).length > 0
            ? {
                  secrets: secretsServer({
                      secrets: secretAccess,
                      accounts: { ...browser.accounts, ...("web" in browser.servers ? { web: "web" } : {}) },
                  }),
              }
            : {}),
        // hashlineEdits: swap the native Edit/Write (disabled below) for hash-anchored file tools.
        ...(hashlineEdits ? { hashline: createHashlineServer(context.localCwd) } : {}),
        // The `wait` tool: park until a child of this turn, a delegated CLI, an Agent-tool subagent, or a
        // spawned agent, is blocked on input or finished (subagent-wait.ts). Always offered, a turn that
        // spawns nothing simply never calls it, and settled by the turn's own signal when the user stops the
        // turn under it. `spawn` rides the same server where the route injected its engine: start a full agent
        // on any connected provider and supervise it with the wait beside it. Withheld from a persona without
        // the delegate shelf and full agency: a child is a whole agent with shell and write, so a card that
        // narrowed this turn to less must not get them back by proxy.
        subagents: subagentWaitServer({
            conversationId: context.base.conversationId,
            signal: context.base.signal,
            ...(context.children !== undefined && persona.powers.delegate && persona.powers.shell && persona.powers.files === "write"
                ? { children: context.children }
                : {}),
        }),
        /* The condition watch (agent/watchers.ts): the agent states an OUTSIDE condition once, a check command
         * that exits 0 when it holds, and the daemon does the polling, waking this conversation when it fires.
         * The replacement for hand-rolled sleep loops and for the CLI's own scheduling tools, which accept
         * schedules that can never fire once the turn's process is gone (agent.ts disallows them). Withheld
         * from a persona without shell, the check IS a shell command run on the agent's word, and from a
         * conversationless turn, whose wake would have nowhere to land. The check runs in the DAEMON's view of
         * the turn's tree with the turn's capability credentials, both snapshotted at arm time. */
        ...(persona.powers.shell && input.conversationId !== undefined
            ? {
                  watch: watchServer({
                      conversationId: input.conversationId,
                      cwd: context.localCwd,
                      // The BASE's env, the persona-filtered one, for the same reason shellEnv below reads
                      // it: a check must not run with a credential the card withheld from the turn that arms it.
                      env: context.base.cliEnv ?? {},
                      commandRules,
                      turn: {
                          ...(input.agent !== undefined ? { agent: input.agent } : {}),
                          ...(input.harness !== undefined ? { harness: input.harness } : {}),
                          ...(input.account !== undefined ? { account: input.account } : {}),
                          ...(input.model !== undefined ? { model: input.model } : {}),
                          ...(input.effort !== undefined ? { effort: input.effort } : {}),
                          ...(input.isolated === true ? { isolated: true } : {}),
                          ...(input.unattended === true ? { unattended: true } : {}),
                      },
                  }),
              }
            : {}),
        /* Dependency readiness, asked rather than announced, and asked of the MAIN checkout, for the reason
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
        /* The daemon's own records, asked instead of re-derived (logs/diagnostics-tools.ts). What the daemon
         * wrote down about failures, slow work, turn outcomes and machine resources, filtered by window and
         * level rather than tailed.
         *
         * Gated on `files` rather than on a power of its own: these are reads of daemon-owned files, and a
         * persona that may not read the workspace has no business reading the daemon's log either. Nothing here
         * writes, and nothing reaches outside historyRoot/logs and the spend ledger, so a turn can read the
         * record of what it did and never edit it. Withheld from a `none` card whole rather than degraded, a
         * half-answer about why something failed is worse than being told to ask the owner. */
        ...(persona.powers.files === "none"
            ? {}
            : { diagnostics: createDiagnosticsServer({ historyRoot: services.config.historyRoot, usage: services.usage }) }),
    };
    /* The BASE's env, not the context's raw one: the base is where `honoured` already withheld the connector
     * credentials this persona was not granted (personaCliEnv), and rebuilding from the raw context env here
     * was silently handing every one of them back to the harness arm alone. */
    const shellEnv = { ...context.base.cliEnv };
    // The turn's user message: attachment note folded in as before.
    const promptWithAttachments =
        context.attachmentPaths.length > 0 ? withAttachmentNote(context.base.prompt, [...context.attachmentPaths]) : context.base.prompt;
    /* A prompt whose leading `/` names no command this session has, which the CLI would otherwise answer with
     * "Unknown command" and discard, the note keeps the user's words in front of the model (agent-commands.ts
     * decides, turn-preamble.ts explains). Last of the notes, so it sits against the message it describes,
     * which the typed list can actually deliver: the old staple checked the COMPOSED prompt, so any other note
     * in front meant the leading `/` was never at the start and the guard silently never fired. */
    const literalSlash = isUnknownSlashCommand(input.agent ?? "claude", promptWithAttachments);
    const prompt = promptWithAttachments;
    const notes = literalSlash ? [...(context.base.notes ?? []), LITERAL_SLASH_NOTE] : context.base.notes;
    /* Fast speed is a NATIVE-turn ask, so it is held back here and handed only to the branch that keeps the
     * Anthropic credential. A routed turn (codex/grok/kimi/gemini/endpoint under this same loop) is pointed at
     * the sandbox's translator, and the harness refuses fast mode on anything that isn't first-party, so
     * forwarding it there would spend a control the turn cannot honour and report `not_first_party` for the
     * user to decipher. Split off the base rather than overridden below because the field's absence is the
     * whole meaning, and `fast: undefined` is not a thing this repo's tsconfig lets you write. */
    const { fast, ...routable } = context.base;
    const conversation = input.conversationId;
    return {
        ok: true,
        run: services.agent,
        ...(resolved.credentials.account !== undefined ? { account: resolved.credentials.account } : {}),
        request: {
            ...routable,
            prompt,
            ...(notes === undefined ? {} : { notes }),
            // A routed turn (codex/grok under the Claude Code harness) pins the translator endpoint + bearer +
            // mapped model and withholds the Anthropic OAuth token (baseUrl in agent.ts drops
            // CLAUDE_CODE_OAUTH_TOKEN), and, for the same reason, never carries the fast-mode ask. A native
            // Claude turn keeps its OAuth token, may go fast, and falls back to the daemon-wide default model
            // when the turn didn't pin one (a per-automation `model` already rode into `base` above and wins;
            // empty ⇒ subscription default).
            ...(endpoint !== undefined
                ? {
                      baseUrl: endpoint.baseUrl,
                      authToken: endpoint.authToken,
                      model: endpoint.model,
                      ...(allowance !== undefined ? { allowance } : {}),
                      ...(trial === true ? { trial: true } : {}),
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
            // The same directory the browser servers got as `--output-dir`, the hook that redirects model-named
            // screenshots into it needs the value too, and one source keeps them from drifting. Omitted when
            // the turn wired no browser servers (no Chromium in this image, the browser pack rides a rebuild):
            // its absence is what keeps the system prompt from advertising a browser that isn't there.
            ...(Object.keys(browser.servers).length > 0 ? { browserOutputDir: browserOutputDir(services.workspace.root) } : {}),
            // Whether the diagnostics server above was mounted, so the prompt names its four tools only on the
            // turns that can load them: a `files: none` persona hears nothing about records it may not read.
            ...(sdkServers.diagnostics === undefined ? {} : { diagnostics: true }),
            // Whether this turn actually carries the iq plugin, so the notice that fires on an empty `rg` names iq
            // where it is real and stays quiet in the holdout arm and in every sandbox that never opted in.
            iqAvailable: iqLoaded,
            // The debugging ports those same servers' Chromiums will open, so the first browser tool call can
            // register a session the owner can watch (browser/browser-sessions.ts).
            ...(Object.keys(browser.ports).length > 0 ? { browserPorts: browser.ports } : {}),
            // Each logged-in profile owner's passkey store, so the observer that watches those pages also
            // plugs the platform's software security key into them (browser/passkeys.ts).
            ...(Object.keys(browser.passkeys).length > 0 ? { browserPasskeys: browser.passkeys } : {}),
            // The routed server's account→owner map, so the observer resolves a call's `account` argument to
            // the profile it drives, the tool prefix no longer says (browser/browser-sessions.ts).
            ...(Object.keys(browser.accounts).length > 0 ? { browserAccounts: browser.accounts } : {}),
            // The accounts tools ride whenever the turn has browser accounts, the account list is the very set
            // whose servers were just mounted (persona-filtered), which is the scope those tools enforce.
            ...(browserAccountIds.length > 0
                ? {
                      accountsServer: accountsServer({
                          capabilities: services.capabilities,
                          root: services.workspace.root,
                          accounts: browserAccountIds,
                          ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
                          attended: input.unattended !== true,
                          // The two verbs that reach past the narrow deps, filing a new account under an
                          // identity, and reading one code off its linked mailbox, injected as closures so
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
            // Every stored credential masked to its `{{secret:name}}` reference in every tool result, and the
            // two exits that resolve the same reference back, unconditional, because unlike the cleaners this
            // is not a saving that can be traded away (agent/agent-redaction.ts, agent/agent-secrets.ts).
            secrets: secretAccess,
            /* The heavy-command queue, forwarded only where the image can actually enforce it: without
             * bin/queue-run on PATH the rewritten line would name a binary that is not there, which would fail
             * every heavy command instead of pacing it. Checked here rather than inside the hook so the hook
             * stays a pure function of its arguments (and so its tests need no filesystem).
             *
             * A reader, not a snapshot: the file is one a person edits WHILE watching the box, and re-reading
             * per command is what makes that edit worth making (agent/agent-terminals.ts). */
            ...(queueRunEnabled() ? { heavyCommands: () => services.heavyCommands.read() } : {}),
            ...(Object.keys(shellEnv).length > 0 ? { cliEnv: shellEnv } : {}),
            /* The delegation ceilings, forwarded ONLY WHERE THE OWNER MOVED ONE. An untouched cap is left for the
             * harness to answer, which is not the same as sending the number the harness would have picked: the
             * nesting cap is remote-config'd inside the CLI (its 3 is a fallback), so restating today's default
             * as an env var would quietly pin a value that is meant to be able to move. */
            ...(subagentsAtOnce !== SETTINGS_DEFAULTS.subagentsAtOnce ? { subagentsAtOnce } : {}),
            ...(subagentsPerTurn !== SETTINGS_DEFAULTS.subagentsPerTurn ? { subagentsPerTurn } : {}),
            ...(subagentDepth !== SETTINGS_DEFAULTS.subagentDepth ? { subagentDepth } : {}),
            /* Every image-scoped install the turn attempts, into the runtime-install ledger. The hook already
             * classified the command; this only appends, best-effort — a turn must proceed whether or not its
             * bookkeeping did. The conversation id is the recurrence unit: a second DISTINCT session installing
             * the same tool is what earns an auto-drafted overlay step (environment/auto-drafts.ts). */
            onImageInstall: (installs, command) => {
                void services.runtimeInstalls
                    .record(installs, command, input.conversationId, Date.now())
                    .catch((error: unknown) => services.logger.warn({ err: error }, "runtime-install ledger append failed"));
            },
            /* The rules standing where a turn ends, forwarded only when there ARE some so a workspace with none
             * wires no hooks at all. Their CONDITIONS are deliberately not read here: this turn has not run
             * yet, so nothing knows which files it will touch, and a path condition resolved now would be a
             * condition that can never hold (rules/turn-ending.ts reads them at the Stop instead).
             *
             * The runner rides along beside them so a `command` rule has somewhere to run, in the turn's own
             * cwd, which under an isolated turn is the worktree the agent is actually editing. */
            /* WHICH FILES THE TREE SAYS ARE DIRTY, both names each, for the diagnostics a shell command's edits get
             * (agent-shell-edits.ts). Read on every turn, isolated or not: the tracker attributes a file to a
             * command by its mtime moving across that command, so the main checkout's standing dirty set (everyone's
             * landed, uncommitted work) is a baseline there, not a finding. The agent's name for a file is the
             * worktree path mapped back to the root, which is what it is under an anchor and under the redirect. */
            dirtyFiles: async () =>
                (await dirtyPathsAcross(context.localCwd, await discoverRepos(context.localCwd))).map((path) => {
                    const onDisk = join(context.localCwd, path);
                    return { onDisk, path: fromWorktree(onDisk, context.base.isolation?.plan) };
                }),
            /* THE `file.edited` MOMENT, as one reviewer the diagnostics hook set runs on every written file. Its
             * command runs where the Stop's would (ruleCommandIn: inside an anchored turn's namespace), and is
             * handed the file's name as that place spells it: the agent's own under an anchor, the worktree's
             * from the daemon (the same split agent-diagnostics.ts makes for the type check). Firings stamp the
             * settings list only: a per-edit rule that wrote a feed row per save would be the feed's noise. */
            ...(fileEditedRules.length > 0
                ? {
                      editReviewers: [
                          fileEditedReviewer(fileEditedRules, {
                              run: (command, timeoutMs) => spawnEditCommand(context.localCwd)(ruleCommandIn(command, context.base.isolation?.anchor), timeoutMs),
                              roots: [context.localCwd, context.base.isolation?.plan?.root, services.workspace.root].filter(
                                  (root): root is string => root !== undefined,
                              ),
                              place: (file) => (context.base.isolation?.anchor === undefined ? inWorktree(file, context.base.isolation?.plan) : file),
                              onFired: (rule: Rule) => {
                                  void services.ruleFirings
                                      .stamp(rule.id, Date.now())
                                      .catch((error: unknown) => services.logger.warn({ err: error, rule: rule.id }, "rule firing stamp failed"));
                              },
                          }),
                      ].filter((reviewer) => reviewer !== undefined),
                  }
                : {}),
            ...(turnEndingRules.length > 0
                ? {
                      turnEndingRules,
                      // The verdict the land reads (agent/turn-checks.ts). Keyed by conversation, so a turn with
                      // none behind it (the bench) records nothing and nothing later can read it.
                      ...(conversation === undefined
                          ? {}
                          : { onCheckRun: (rule: Rule, run: RuleCommandRun) => recordCheckVerdict(conversation, rule, run) }),
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
                      /* LOGGED LIKE THE PRE-PUSH CHECK IS, because the one thing this run could not answer for
                       * itself was WHERE it ran. A `turn.ending` command that reports a red tree has two very
                       * different causes, the work is broken, or the check never saw the workspace's installed
                       * dependencies at all, and they are told apart by exactly one bit: whether the command
                       * went through the turn's namespace (`anchored`). Without these lines a check that
                       * exited 127 over a missing workspace binary left nothing in the log to name its own
                       * cause, and the only record of it anywhere was a sentence in a model's transcript. */
                      runRuleCommand: async (command: string, timeoutMs: number) => {
                          const anchor = context.base.isolation?.anchor;
                          const from = Date.now();
                          services.logger.info(
                              { command, anchored: anchor !== undefined, cwd: context.localCwd, session: CHECKS_SESSION },
                              "checks: check started",
                          );
                          const run = await runRuleCommand(services, {
                              command: ruleCommandIn(command, anchor),
                              timeoutMs,
                              cwd: context.localCwd,
                              session: CHECKS_SESSION,
                              window: "checks",
                              outputBytes: TURN_RULE_OUTPUT_BYTES,
                          });
                          services.logger.info(
                              {
                                  command,
                                  anchored: anchor !== undefined,
                                  status: run.status,
                                  ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
                                  ...(run.timedOut === true ? { timedOut: true } : {}),
                                  durationMs: Date.now() - from,
                              },
                              "checks: check settled",
                          );
                          return run;
                      },
                      // Asked only after such a command has failed, so this costs a healthy turn nothing: a
                      // check measured while its dependency tree is being rewritten is not a verdict on the
                      // work (rules/turn-ending.ts).
                      dependencyInstalling: async () =>
                          (await services.dependencies.status())
                              .filter((project) => project.state === "installing")
                              .map((project) => (project.dir === "" ? "the workspace root" : project.dir)),
                      /* What the TREE says the turn changed, for the conditions the Stop reads: the edit ledger
                       * hears the edit tools, and an edit made with `sed -i`, a heredoc or a script is heard by
                       * nobody but git. Only for an isolated turn, whose worktree is clean when the turn starts
                       * (land commits the remainder), so its dirty paths are this turn's own; in the main checkout
                       * they would be everyone's landed, uncommitted work. */
                      ...(context.localCwd !== services.workspace.root
                          ? {
                                changedPaths: async () => dirtyPathsAcross(context.localCwd, await discoverRepos(context.localCwd)),
                                /* The `verify-tests` built-in, over the same dirty set and for the same reason only
                                 * here: in the main checkout those test files are everyone's, and the fault check
                                 * would revert a sibling agent's landed source to measure this turn's test. */
                                verifyTests: () =>
                                    verifyTestsMessage({
                                        root: context.localCwd,
                                        changed: async () => dirtyPathsAcross(context.localCwd, await discoverRepos(context.localCwd)),
                                        faults: (testFile: string) => passesAgainstHead(testFile, { repoRoot: context.localCwd }),
                                    }),
                            }
                          : {}),
                  }
                : {}),
            // The sniffer's rulebook, forwarded only when the owner wrote a rule, same no-hook economy.
            ...(Object.keys(actionRules).length > 0 ? { actionRules } : {}),
            /* The command gate's rulebook. Forwarded when non-empty, but unlike the sniffer's above, an empty
             * one no longer means "no hook": the gate is wired on every turn because it also carries the taint
             * floor, which is not the owner's rulebook but a fact about what this turn has read (agent.ts). */
            ...(Object.keys(commandRules).length > 0 ? { commandRules } : {}),
            // The card's plain-sentence pass, undefined unless the owner switched it on; see explainerFor.
            explainCommand: explainerFor(services, explainCommands),
            /* Whether outside content CAUSED this turn, and what to call it. A listener wake is a stranger's
             * message and a webchat wake is a stranger on a public widget, the same distinction the admission
             * floor draws (guard/actions.ts wakeSourceOf), read here for the taint the command gate consults.
             * The mid-turn half marks itself as results are wrapped. */
            ...(input.outsideWake !== undefined ? { outsideWake: input.outsideWake } : {}),
            // Mid-turn steering (the /agent/steer queue streamAgent registered). Claude Code harness only.
            ...(context.steering !== undefined ? { steering: context.steering } : {}),
            // The rebase the cards take back while the user is answering them, isolated turns only.
            ...(context.resync !== undefined ? { resync: context.resync } : {}),
        },
    };
};
