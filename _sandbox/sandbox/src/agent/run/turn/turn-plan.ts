import { createHash } from "node:crypto";
import { join } from "node:path";
import {
    type AgentCapabilities,
    type AgentEvent,
    type AgentTurn,
    type Capability,
    type CredentialGate,
    type CredentialGateKind,
    type ModelPin,
    type Rule,
    type SandboxSettings,
    type SystemPromptMode,
    type TurnNote,
    SandboxSettingsSchema,
    capabilitiesOf,
    envSuffix,
} from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { type IsolationAnchor, fromWorktree, inWorktree, nsenterPrefix } from "../../../agents/worktrees/isolation.js";
import { admitTurn, readMemoryHeadroom } from "../../../platform/resources/memory-admission.js";
import { createFreshnessResolver } from "../../../dependencies/registry-freshness.js";
import { createWorkspacePins } from "../../../dependencies/workspace-pins.js";
import { statePath } from "../../../workspace/layout/state-paths.js";
import { dirtyPathsAcross } from "../../../git/changes/changes.js";
import { discoverRepos } from "../../../workspace/layout/repo-discovery.js";
import { accountsServer } from "../../../browser/tools/accounts-tools.js";
import { secretsServer } from "../../../browser/tools/secrets-tools.js";
import type { SecretAccess } from "../../tools/agent-secrets.js";
import { gateTargetOf } from "../../../secrets/credential-gates.js";
import { gatedCapabilities, gatedCliEnv, gatedCredentialsNote, gatedSkills } from "../../../secrets/credential-gating.js";
import { fetchEmailCode } from "../../../browser/tools/email-codes.js";
import { openBrowserAccount } from "../../../capabilities/open-account.js";
import { browserOutputDir } from "../../../browser/cast/browser-artifacts.js";
import { browserServersOf } from "../../../browser/tools/browser-tools.js";
import { personaKitPlugin, readPersonaPrompt } from "../../../personas/persona-kit.js";
import {
    type TurnPersona,
    personaCapabilities,
    personaCliEnv,
    personaDisallowedTools,
    personaNote,
    personaPrompt,
    turnPersona,
} from "../../../personas/personas.js";
import { personaScopeOf } from "../../../personas/persona-scope.js";
import { jsExecutionPlanOf } from "../../../execution/js-runtime.js";
import { resolveWithin } from "../../../workspace/files/workspace-files-paths.js";
import { peerToolsOf } from "../../../peers/peer-tools.js";
import { mcpToolsOf } from "../../../capabilities/mcp-tools.js";
import { pluginDirsOf } from "../../../capabilities/plugin-dirs.js";
import type { Services } from "../../../composition.js";
import { extensionAgentDirsOf } from "../../../extensions/installed-extensions.js";
import { createHashlineServer } from "../../../hashline/hashline-tools.js";
import { createDiagnosticsServer } from "../../../logs/diagnostics-tools.js";
import { type RuleCommandRun, runRuleCommand } from "../../../rules/rule-command.js";
import { fileEditedReviewer, spawnEditCommand } from "../../../rules/file-edited.js";
import { verifyTestsMessage } from "../../verification/agent-tests.js";
import { passesAgainstHead } from "../../verification/agent-test-strength.js";
import { recordCheckVerdict } from "../../verification/turn-checks.js";
import { standing } from "../../../rules/rules.js";
import type { FollowUpOutcome } from "../../../rules/turn-ending.js";
import { turnEndingNote } from "../../../rules/turn-ending-note.js";
import { CHECKS_SESSION } from "../../../terminal/terminal-session.js";
import { queueRunEnabled } from "../../../terminal/terminal-run.js";
import type { AgentRequest } from "../agent.js";
import { armSupervisor, type ChildSupervisor } from "../../subagents/children.js";
import { SPAWN_NOTE_TITLE, spawnNote } from "../../subagents/spawn-note.js";
import { adapterFor } from "../../providers/adapter-registry.js";
import { isUnknownSlashCommand } from "../../providers/agent-commands.js";
import type { SteeringQueue } from "../../anchors/agent-steering.js";
import { withAttachmentNote } from "../../prompt/attachment-note.js";
import { contextShortfall } from "../../prompt/context-budget.js";
import { subagentWaitServer } from "../../subagents/subagent-wait.js";
import { watchServer } from "../../verification/watch-server.js";
import type { WatcherTurnSeed } from "../../verification/watchers.js";
import { seedFields } from "./turn-seed.js";
import { resolveHarnessCredentials } from "../../providers/harness-credentials.js";
import { turnPromptPlacement } from "../../prompt/system-prompt.js";
import { composeWirePrompt, LITERAL_SLASH_NOTE, worktreeNote, worktreeReminder } from "../../prompt/turn-preamble.js";
import { WORKSPACE_MAP_NOTE_TITLE, workspaceMapNote } from "../../prompt/workspace-map.js";
import { workspaceMemoryNote } from "../../prompt/workspace-memory.js";
import { createDepsServer } from "../../../workspace/deps/deps-tools.js";
import { dependencyDirForCommand } from "../../tools/agent-deps.js";
import { setupNoticeFor, setupNoticeTitle } from "../../../workspace/layout/workspace-setup.js";
import { loadedSkillCatalogNote, SKILL_CATALOG_NOTE_TITLE } from "../../../settings/loaded-skills.js";
import { compactedSinceLastTurn } from "../../../agents/registry/agents-store.js";
import { contextNoteIfDue } from "../../context/conversation-context.js";
import { IQ_SEARCH_INSTRUCTION_TITLE, iqSearchInstruction } from "../../prompt/iq-search-instruction.js";
import { judgeCommand } from "../../tools/command-judge.js";
import type { CommandGateOptions } from "../../../guard/command-gate.js";

// Decides which runtime serves a turn and assembles what it's handed, replacing what used to be a four-arm if/else in
// the route. A refusal is a value (`ok: false` + code, as in harness-credentials.ts); the route turns it into the
// composer's connect-gate error frame.

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
          // The provider account serving this turn, stamped onto usage/rate-limit frames and the activity log;
          // undefined for a container-env credential or an untracked translator subscription.
          readonly account?: string;
          // The iq-search experiment's conversation-level arm; fixed once a skill enters a provider session, since a
          // later turn can't un-contaminate it.
          readonly searchArm?: boolean;
          readonly searchCohort?: string;
          // Which turn of its conversation this is, from zero, so the ledger can recognise an opening turn.
          readonly turnIndex?: number;
          // The project map experiment's arm, conversation-level: the note rides the opening message and stays in the
          // transcript.
          readonly mapArm?: boolean;
          // The map note's cost in characters, present only on the turn that actually sent one; read off the composed
          // request, not predicted.
          readonly mapChars?: number;
          readonly request: AgentRequest;
      };

// What the route has already resolved before a provider can be picked: the request every arm builds on, the turn's two
// cwds (see runTurn), and the seams only some arms use.
export interface TurnContext {
    readonly base: AgentRequest;
    // Workspace-relative attachments, already resolved to absolute paths and escape-checked by the route.
    readonly attachmentPaths: readonly string[];
    // The tree as the daemon reaches it; anything the daemon itself touches (hashline edits, the dependency probe) must
    // use this, not effectiveCwd.
    readonly localCwd: string;
    // The workspace root as the agent sees it; what a session id is looked up against.
    readonly effectiveCwd: string;
    readonly cliEnv: Record<string, string>;
    // Mid-turn steering, present only where the runtime declares it (capabilitiesOf().steering).
    readonly steering: SteeringQueue | undefined;
    // Resolved once above the provider split; optional only for a focused caller that invokes an arm directly.
    readonly settings?: SandboxSettings;
    readonly conversationTurns?: number;
    readonly iqSearchEnabled?: boolean;
    readonly iqSearchNote?: string;
    // Generated skill catalogue for a runtime with no native skill loader; opening turn only, carried after by the
    // provider session.
    readonly skillCatalogNote?: string;
    // Which repos this conversation's tree holds or lacks, for a conversation on a context shelf; opening turn and the
    // turn after a compaction.
    readonly contextNote?: TurnNote;
    // The `agents` CLI teaching for shell-only runtimes, on a conversation's opening turn where the spawn door is open.
    readonly spawnNote?: string;
    readonly iqSearchCohort?: string;
    // Who the turn is and what it may do, resolved once by planTurn; absent on the context the route builds before a
    // card is read.
    readonly persona?: TurnPersona;
    // Re-takes the pre-turn rebase while parked on a card; isolated, harness-only turns, since only the harness's cards
    // park long enough to need it.
    readonly resync?: () => Promise<AgentEvent | undefined>;
    // Child-agent supervision, injected by agent.routes like `resync`; absent for a conversationless turn or a focused
    // caller with no route.
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
/* THE SAFETY JUDGE, BOUND TO THIS SANDBOX'S ACCOUNTS AND TO THIS TURN'S POLICY AND MODEL.
 *
 * A closure over `services`, the policy text and the owner's model pin rather than any of them directly, because
 * the seam it fills lives in guard/, which is deliberately ignorant of accounts, chains and quotas (see
 * CommandGateOptions.judge), and because both of those settings must be the one snapshot this turn was planned
 * with rather than whatever the files say at the moment a command happens to run.
 *
 * Always present, unlike the explainer it replaced — that was off unless the owner switched it on, because it
 * was a nicety on a card. This is the decision itself, and a turn without it would be a turn where the hard rule
 * is the only thing standing. What keeps it cheap is that the gate only calls it when triage fires, and memoises
 * per program within the turn; whether it is called AT ALL is the owner's (settings.commandJudge, carried beside
 * this as `judging`), and at `off` the gate never reaches this closure. */
/* THE TURN IDENTITY A WATCH'S WAKE HAS TO REPRODUCE: where the arming turn ran, on whose account, at what tier,
 * with what reasoning, as which persona, in what posture, and what job it was.
 *
 * The list belongs to agent/run/turn/turn-seed.ts rather than here, because the proof follow-up needs exactly the
 * same one and the two used to keep separate, differently incomplete copies of it. A wake that fires four hours
 * later has nobody to ask what it should have been; every answer it gets has to have been written down at arm
 * time, and a field this forgets is a field the wake silently changes. */
const watchSeed = (input: AgentTurn): WatcherTurnSeed => seedFields(input);

const judgeFor =
    (services: Services, policy: string, pins: readonly ModelPin[] | undefined): CommandGateOptions["judge"] =>
    (program, facts, signal) =>
        // An unpinned role reads as an empty list, which the walk answers with its Auto ladder.
        judgeCommand(services, { policy, program, facts, pins: pins ?? [] }, signal);

// Deterministic per conversation id, with no state stored. `experiment` salts the hash so two experiments draw
// independent buckets for the same conversation instead of always agreeing.
export const conversationExperimentArm = (experiment: string, conversationId: string | undefined, holdout: number): boolean => {
    if (conversationId === undefined) {
        return Math.random() >= holdout;
    }
    const bucket = createHash("sha256").update(`${experiment}:${conversationId}`).digest().readUInt32BE(0) / 0x1_0000_0000;
    return bucket >= holdout;
};

// Undefined means not measuring, which downstream treats as no experiment rather than a control turn. One function for
// both experiments, since the same three conditions gate an arm each time.
const holdoutArm = (experiment: string, on: boolean, holdout: number, conversationId: string | undefined): boolean | undefined =>
    on && holdout > 0 && conversationId !== undefined ? conversationExperimentArm(experiment, conversationId, holdout) : undefined;

// Every field is omitted rather than defaulted, since absent is what readers treat as unmeasured and zero would look
// like a measured nothing. Map size is read off the composed notes, not the decision to send one.
const experimentStamps = (
    turnIndex: number | undefined,
    search: { readonly arm: boolean | undefined; readonly cohort: string | undefined },
    map: { readonly arm: boolean | undefined; readonly notes: readonly TurnNote[] | undefined },
): { turnIndex?: number; searchArm?: boolean; searchCohort?: string; mapArm?: boolean; mapChars?: number } => {
    const chars = map.notes?.find((note) => note.title === WORKSPACE_MAP_NOTE_TITLE)?.text.length;
    return {
        ...(turnIndex !== undefined ? { turnIndex } : {}),
        ...(search.arm !== undefined
            ? { searchArm: search.arm, ...(search.cohort !== undefined ? { searchCohort: search.cohort } : {}) }
            : {}),
        ...(map.arm !== undefined ? { mapArm: map.arm } : {}),
        ...(chars !== undefined ? { mapChars: chars } : {}),
    };
};

// Runs a rule's command inside the turn's own namespace via nsenter, like the Bash tool's rewrite, since the
// daemon-side worktree has empty dependency directories. `bash -c` with the whole line quoted, since nsenter takes an
// argv and a rule's command is a shell line.
export const ruleCommandIn = (command: string, anchor: IsolationAnchor | undefined): string =>
    anchor === undefined ? command : `${nsenterPrefix(anchor.pid, anchor.cwd)}bash -c ${shellQuote(command)}`;

export const planTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    // Checked before anything else and above the dispatch, so a box out of memory refuses every provider arm alike, and
    // a refused turn costs no settings read, capability list, dependency probe or persona load. Uncapped sandboxes and
    // cgroup-blind daemons admit unconditionally.
    const admission = admitTurn(await readMemoryHeadroom(), context.base.unattended === true);
    if (!admission.admit) {
        return { ok: false, code: "sandbox-memory-low", message: admission.message };
    }
    // Harness is orthogonal to provider: "native" runs each provider on its own runtime, "claude-code" forces the
    // Claude Code Agent SDK loop for any provider. The arm that serves a turn and capabilitiesOf read the same
    // (provider, harness) row, so they can't disagree.
    const provider = input.agent ?? "claude";
    const harness = input.harness ?? "native";
    const capabilities = capabilitiesOf(provider, harness);
    // How many turns have run in this conversation and whether one of them compacted (PersistedAgent.compactedTurn),
    // read together off one lookup since every say-once note has to answer both "is it in the history" and "is that
    // history still there".
    const entry = input.conversationId === undefined ? undefined : services.agents.entry(input.conversationId);
    const conversationTurns = entry?.turns ?? 0;
    // Resolved before dispatch since the composition of this turn's instructions reads it (see `honoured` below).
    const settings = context.settings ?? (await services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get()));
    const [installed, setup, cast, skillCatalogNote, contextNote] = await Promise.all([
        // cli/mcp/plugin/browser/agent-kind capabilities the owner installed; not the persona-filtered record, which
        // answers what the runtime can do instead.
        services.perf.track("turn.plan.capabilities", {}, () => services.capabilities.list()),
        // Read against the main checkout, not the turn's worktree: an isolated turn's worktree mounts dependencies as
        // empty directories the daemon can't see through, so probing it would report everything as uninstalled.
        // Skipped for a full runtime (asks through its own deps server) or a resumed session (re-scanning per follow-up
        // just to discard the answer wastes the probe).
        capabilities.mcp === "full" || context.base.sessionId !== undefined
            ? Promise.resolve([])
            : services.perf.track("turn.plan.deps", {}, () => services.dependencies.status()),
        // Read unconditionally: gating it on `actsAs` would skip the one case that matters, an unattended wake naming
        // nobody, whose answer must still be "no accounts".
        services.perf.track("turn.plan.personas", {}, () => services.personas.list()),
        // Native skill loaders read the filesystem themselves; everyone else gets this generated catalogue once, on the
        // opening request, with paths as the agent sees them. Rides the user preamble, not systemAppend, since Pi/ACP
        // have no system seam and a custom prompt must not hide tools.
        capabilities.skillDiscovery === "prompt" && conversationTurns === 0
            ? services.perf.track("turn.plan.skills", {}, () => loadedSkillCatalogNote(context.localCwd, context.effectiveCwd))
            : Promise.resolve(undefined),
        // What the conversation's tree holds, for a conversation a context shelf narrowed, on the two turns that owe
        // the note.
        services.perf.track("turn.plan.context", {}, () => contextNoteIfDue(services, input, entry, conversationTurns)),
    ]);
    // Resolved above the provider split so every runtime, not just the Claude Code plan, inherits the same account and
    // tool bounds instead of enforcing the card on only one dropdown's worth of sessions.
    const persona = turnPersona({ personas: cast, actsAs: input.actsAs, unattended: input.unattended === true });
    if (persona.reason === "unknown-persona") {
        // The turn asked to act as somebody this workspace has no card for, so it runs with nothing while the prompt
        // still reads as if it had everything.
        services.logger.warn({ actsAs: input.actsAs }, "persona: no such card, this turn reaches no account and no tools");
    }
    // The manifest narrowed once and handed to every arm, so a shelf means the same thing on every runtime and a
    // capability kind added later isn't silently denied everywhere.
    const personaGranted = personaCapabilities(installed, persona);
    // Owner approval gates, applied once above every runtime; a withheld mount is noted via `honoured` since a silent
    // absence would read as unconnected. An unreadable policy withholds nothing here (logged), since anything that
    // actually spends a credential still refuses on its own read failure.
    const gates = await services.credentialGates.list().catch((error: unknown) => {
        services.logger.warn({ err: error }, "credential gates: the approval policy could not be read, no capability is withheld this turn");
        return [] as const;
    });
    const gatedMounts = gatedCapabilities(personaGranted, gates, services.credentialGrants, input.conversationId);
    const granted = gatedMounts.capabilities;
    // The spawn door, decided once for every runtime: a persona needs both the delegate shelf and full agency (shell +
    // write) to start agents elsewhere, since a child is a whole agent holding both; without them, spawning must not
    // come back by proxy.
    const maySpawn =
        context.children !== undefined &&
        input.conversationId !== undefined &&
        persona.powers.delegate &&
        persona.powers.shell &&
        persona.powers.files === "write";
    if (maySpawn && context.children !== undefined && input.conversationId !== undefined) {
        armSupervisor(input.conversationId, context.children);
    }
    // CLI teaching for shell-only-door runtimes (not the Claude Code loop or Cursor, which carry the tools in-prompt
    // already), sent once on the conversation's opening turn like the iq teaching.
    const spawnNoteText =
        maySpawn && capabilities.runtime !== "claude-code" && capabilities.runtime !== "cursor" && conversationTurns === 0 ? spawnNote() : undefined;
    // "iq-search" is the salt this experiment has always used, kept verbatim so a running conversation keeps its
    // assigned arm rather than being re-randomized.
    const searchArm = holdoutArm("iq-search", settings.iqSearch, settings.iqSearchHoldout, input.conversationId);
    const iqSearchEnabled = searchArm ?? settings.iqSearch;
    // Claude Code loads the source as a plugin; other runtimes get the same text once, on the opening request, carried
    // after by the provider session.
    const teaching =
        services.config.iqPluginDir !== "" &&
        (searchArm !== undefined || (capabilities.runtime !== "claude-code" && iqSearchEnabled && conversationTurns === 0))
            ? await iqSearchInstruction(services.config.iqPluginDir).catch((error: unknown) => {
                  services.logger.warn({ err: error }, "iq search: could not load the cross-harness instruction");
                  return undefined;
              })
            : undefined;
    const iqSearchNote = capabilities.runtime !== "claude-code" && iqSearchEnabled && conversationTurns === 0 ? teaching?.note : undefined;
    // Which prompt this turn runs on, the sandbox's or the persona's own (personaPrompt); the card's own text is read
    // only when it asked for one, so an ordinary turn (`inherit`) pays nothing.
    const prompt = personaPrompt(
        persona.persona,
        persona.persona?.systemPromptMode === "custom" ? await readPersonaPrompt(services.workspace.root, persona.persona.id) : undefined,
        settings,
    );
    const shared: TurnContext = {
        ...context,
        settings,
        conversationTurns,
        iqSearchEnabled,
        ...(iqSearchNote !== undefined ? { iqSearchNote } : {}),
        ...(skillCatalogNote !== undefined ? { skillCatalogNote } : {}),
        ...(contextNote !== undefined ? { contextNote } : {}),
        ...(teaching !== undefined ? { iqSearchCohort: teaching.cohort } : {}),
        ...(spawnNoteText !== undefined ? { spawnNote: spawnNoteText } : {}),
    };
    // The map is sent once, on a conversation's opening (non-fork) message, since it's in the transcript and the layout
    // hasn't moved by the second turn. Unattended wakes still get it; a holdout control conversation never does,
    // stamped per conversation since the map stays in the transcript once sent.
    const mapArm = holdoutArm("workspace-map", settings.workspaceMap, settings.workspaceMapHoldout, input.conversationId);
    const workspaceMapEligible = (mapArm ?? settings.workspaceMap) && input.forkOf === undefined && conversationTurns === 0;
    // The turn-ending note is sent once, on the opening (non-fork) message, and again after a compaction: by the second
    // turn it's already in the session history, but a compaction summarizes that history away. `>=` rather than `===`
    // since a compaction is filed under the turn it happened in, and the following turn is the one that owes the note.
    const turnEndingEligible = (conversationTurns === 0 && input.forkOf === undefined) || compactedSinceLastTurn(entry, conversationTurns);
    const planned: TurnContext = {
        ...shared,
        base: honoured(
            services,
            shared,
            capabilities,
            setupNoticeFor(setup),
            persona,
            installed,
            prompt,
            {
                map: workspaceMapEligible,
                turnEnding: turnEndingEligible,
            },
            { gates, withheld: gatedMounts.withheld },
        ),
        persona,
    };
    // The last gate before an arm builds a request, and the only one that reads the composed prompt rather than what's
    // connected (context-budget.ts); run after `planned` since it measures the prompt as it will actually be sent,
    // notes and all.
    const shortfall = await contextShortfall(services, {
        provider,
        runtime: capabilities.runtime,
        ...(input.model !== undefined ? { model: input.model } : { model: undefined }),
        // The prompt as it will be sent, notes and all: the same serialization dispatch performs.
        prompt: composeWirePrompt(planned.base.notes ?? [], planned.base.prompt),
    });
    if (shortfall !== undefined) {
        services.logger.warn(
            { provider, model: input.model, window: shortfall.window, needed: shortfall.needed },
            "context: the model's window cannot hold a turn of this loop, refused before sending",
        );
        return { ok: false, code: "context-window-too-small", message: shortfall.message };
    }
    // Dispatched through the adapter registry rather than an if/else chain, so the set of runtimes has one declaration
    // and the picker's health probe sits beside the arm it predicts.
    const plan = await adapterFor(provider, harness).preflight(services, input, planned, granted);
    if (!plan.ok) {
        return plan;
    }
    return {
        ...plan,
        ...experimentStamps(
            input.conversationId === undefined ? undefined : conversationTurns,
            { arm: searchArm, cohort: teaching?.cohort },
            { arm: mapArm, notes: planned.base.notes },
        ),
    };
};

// The one point every provider arm passes through: unhonoured controls are dropped, and every runtime-agnostic fact
// (worktree location, pre-turn rebase, dependency readiness, persona shelves, standing instructions) is applied exactly
// once here instead of risking silent drift per arm.
const honoured = (
    services: Services,
    context: TurnContext,
    capabilities: AgentCapabilities,
    setupNotice: string | undefined,
    persona: TurnPersona,
    // Unfiltered manifest: needed to know which connectors exist, so their credentials can be withheld; the filtered
    // list can't say that.
    installed: readonly Capability[],
    // Which system prompt this turn runs on, the persona's answer already resolved against the sandbox's
    // (personaPrompt).
    prompt: { readonly mode: SystemPromptMode; readonly systemPrompt: string },
    // Which say-once notes this turn owes, decided by the caller (which reads `input` and the conversation entry). One
    // record, not two positional booleans, since two flags of the same type invite a swap that would typecheck.
    send: { readonly map: boolean; readonly turnEnding: boolean },
    // The owner's credential gates: `gates` builds the environment's withholding here, `withheld` covers what the mount
    // filter already took upstream.
    gating: { readonly gates: readonly CredentialGate[]; readonly withheld: readonly CredentialGate[] },
): AgentRequest => {
    const { permissionMode, effort, fast, cliEnv, disallowedTools, ...rest } = context.base;
    // An isolated conversation's worktree is not the workspace root; a main-tree turn has nothing to say here.
    const isolated = context.localCwd !== services.workspace.root;
    // What this turn is told before the user says anything, and where each piece can go on the runtime serving it
    // (system-prompt.ts owns both halves as one decision). Undefined settings means a focused caller with no route (the
    // bench); it gets the schema defaults.
    const settings = context.settings ?? SETTINGS_DEFAULTS;
    // Where the card says to start, resolved through the workspace escape guard; a path that fails it is dropped rather
    // than refused, so a typo'd folder opens at the workspace root instead of failing the session outright. Resolved
    // ahead of the instructions, which read the start folder to know whose standing rules apply.
    const startIn = persona.workspace?.startIn;
    const startPath = startIn === undefined || startIn === "" ? undefined : resolveWithin(context.effectiveCwd, startIn);
    // The same starting position as the daemon reaches it: `startPath` is a namespace address the daemon isn't inside,
    // so anything read off disk goes through `localCwd` instead. The root moves with an isolated turn, since its world
    // is its own worktree.
    const localRoot = isolated ? context.localCwd : services.workspace.root;
    const localStart = startIn === undefined || startIn === "" ? localRoot : resolveWithin(localRoot, startIn);
    // Which persona the turn wears, said once; undefined when there's nothing to say (an ordinary attended turn naming
    // no persona).
    const actingNote = personaNote(persona);
    // The owner's standing instructions, every turn and every runtime, from the root down to the start folder; composed
    // here because no two runtimes discover them the same way, and one of them (`instructions: "none"`) discovers
    // nothing at all.
    const memoryNote = workspaceMemoryNote({ root: localRoot, cwd: localStart ?? localRoot });
    const placement = turnPromptPlacement({
        capabilities,
        ...prompt,
        stableSystemPrompt: settings.stableSystemPrompt,
        ...(actingNote === undefined ? {} : { personaNote: actingNote }),
        ...(memoryNote === undefined ? {} : { memoryNote }),
    });
    // The project map, sent only on a conversation's opening message, here rather than in the harness arm since it's a
    // filesystem fact true of every runtime. A start folder outside the root is dropped by the escape guard, mapping the
    // root as the session actually opens there.
    const mapNote = send.map && localStart !== undefined ? workspaceMapNote({ root: localRoot, cwd: localStart }) : undefined;
    // The environment through two filters: the persona's (what this turn may reach) and the gate's (what a person has
    // released). A connector caught by either loses every env var carrying its suffix outright, rather than being
    // merely discouraged.
    const personaEnv = cliEnv === undefined ? undefined : personaCliEnv(cliEnv, installed, persona, envSuffix);
    const gatedEnv =
        personaEnv === undefined
            ? undefined
            : gatedCliEnv(personaEnv, installed, gating.gates, services.credentialGrants, context.base.conversationId, envSuffix);
    const notes: TurnNote[] = [
        // First of the preamble, when there is one: who the turn is acting as belongs ahead of anything about files or
        // tools.
        ...(placement.userNotes ?? []),
        ...(isolated && capabilities.isolation === "cwd"
            ? [
                  context.base.sessionId === undefined
                      ? worktreeNote(context.localCwd, services.workspace.root)
                      : worktreeReminder(services.workspace.root),
              ]
            : []),
        ...(mapNote === undefined ? [] : [{ title: WORKSPACE_MAP_NOTE_TITLE, text: mapNote }]),
        // After the map, which draws the tree; before the skills: what the tree holds is the next question a narrowed
        // map raises.
        ...[context.contextNote].filter((note) => note !== undefined),
        ...(context.skillCatalogNote === undefined ? [] : [{ title: SKILL_CATALOG_NOTE_TITLE, text: context.skillCatalogNote }]),
        // Fallback only, for runtimes with no readiness mechanism to fall back from: a `full` runtime gets tools and
        // real-failure hooks instead, so stapling this too would repeat the same facts on every turn regardless of
        // need. Runtimes with neither still get the paragraph, unchanged.
        ...(setupNotice !== undefined && capabilities.mcp !== "full" ? [{ title: setupNoticeTitle(setupNotice), text: setupNotice }] : []),
        ...(context.iqSearchNote !== undefined ? [{ title: IQ_SEARCH_INSTRUCTION_TITLE, text: context.iqSearchNote }] : []),
        ...(context.spawnNote !== undefined ? [{ title: SPAWN_NOTE_TITLE, text: context.spawnNote }] : []),
        // What a named approver must release before this turn can use it, over both filters at once. Sent on every turn
        // missing something, not once per conversation like the teaching notes above, since the condition changes the
        // moment someone clicks.
        ...[gatedCredentialsNote([...gating.withheld, ...(gatedEnv?.withheld ?? [])])].filter((note) => note !== undefined),
        // Every runtime gets the check now: the Claude Code loop runs the command rules at its Stop, the daemon runs them
        // for the rest once the frames end (agent.routes.ts daemonStopFindings), so the promise holds either way.
        ...(send.turnEnding ? [turnEndingNote(settings.rules)].filter((note) => note !== undefined) : []),
    ];
    // Ungranted connectors are removed from the shell environment outright, not merely left with an instruction to
    // ignore them.
    const shellEnv = gatedEnv?.cliEnv;
    // Three sources concatenated: whatever the request already carried, the shelves this persona lacks, and the skills
    // tied to credentials a named approver hasn't released (a cheatsheet without its credential would dangle).
    const withheldCredentials = [...gating.withheld, ...(gatedEnv?.withheld ?? [])];
    const denied = [...(disallowedTools ?? []), ...personaDisallowedTools(persona, installed), ...gatedSkills(withheldCredentials)];
    const dependencyDir = startIn ?? "";
    const dependencyInstallAllowed = persona.powers.files === "write" && persona.powers.shell;
    // The JS backend's plan, resolved here where persona, tree and filtered environment are all in hand. Gated on the
    // runtime hosting it and on the card inside jsExecutionPlanOf, so an ungranted backend is absent rather than
    // present-and-refused.
    const jsExecution = capabilities.execution.includes("js")
        ? jsExecutionPlanOf(persona, { root: context.effectiveCwd, cwd: startPath ?? context.base.cwd }, { ...shellEnv })
        : undefined;
    // Folder limit and sandbox switch, resolved against the workspace root rather than `startPath`: a persona can start
    // in one repo while reading a sibling, which anchoring to the start folder would make unsayable.
    const scope = personaScopeOf(persona, context.effectiveCwd);
    return {
        ...rest,
        // The user's own words stay bare; notes ride typed beside them and are serialized into the wire string only
        // once, at dispatch (composeWirePrompt). Stapling here made the literal-slash guard and the transcript parser
        // silently miss the notes.
        notes,
        // The composed instructions, carried on the request itself now rather than assembled per-runtime; which of
        // systemPrompt/systemAppend is set is the runtime's own declared answer (AgentCapabilities.instructions).
        systemPromptMode: prompt.mode,
        ...(placement.systemPrompt !== undefined ? { systemPrompt: placement.systemPrompt } : {}),
        ...(placement.systemAppend !== undefined ? { systemAppend: placement.systemAppend } : {}),
        // How this runtime enforces the owner's command rulebook, read from the pair's own record rather than hardcoded
        // per adapter, so a lying row changes turn behavior, not just what the composer displays.
        rulebook: capabilities.rulebook,
        // Set here since this is the last point that can still tell the workspace root from the turn's cwd, before a
        // persona's start folder or an isolated worktree overwrites it.
        workspaceRoot: services.workspace.root,
        dependencyIssue: (command) => services.dependencies.issueAt(dependencyDirForCommand(dependencyDir, services.workspace.root, command)),
        dependencyInstallAllowed,
        // Bound here for the same reason as the dependency answer above: the last point that still knows the workspace
        // root, which the resolver's cache is keyed to. Built even when the setting is off, since it holds no
        // connection until asked.
        dependencyFreshness: settings.dependencyFreshness,
        freshnessResolver: createFreshnessResolver({ cacheDir: statePath(services.workspace.root, ".intentic/local/cache/", "freshness") }),
        // Lazy: walked on the first pin a turn actually sees, so a turn touching no manifest pays nothing for building
        // this.
        workspacePins: createWorkspacePins(services.workspace.root),
        ...(startPath !== undefined ? { cwd: startPath } : {}),
        ...(scope !== undefined ? { personaScope: scope } : {}),
        ...(shellEnv !== undefined && Object.keys(shellEnv).length > 0 ? { cliEnv: shellEnv } : {}),
        ...(jsExecution !== undefined ? { jsExecution } : {}),
        ...(denied.length > 0 ? { disallowedTools: denied } : {}),
        // A "plan" runtime knows only propose-then-approve or run; every other mode means the second, so it travels as
        // the absence that already meant it.
        ...(permissionMode !== undefined && (capabilities.permissions === "modes" || permissionMode === "plan") ? { permissionMode } : {}),
        ...(effort !== undefined && capabilities.effort ? { effort } : {}),
        // Fast speed, for runtimes that can ask for it (Claude Code loop alone); the harness's own refusal for a
        // non-first-party endpoint is applied later in planHarnessTurn, since this is a pure function of (provider,
        // harness) with no credential to see.
        ...(fast === true && capabilities.fastMode ? { fast } : {}),
    };
};

// planCodexTurn, planGrokTurn, planCursorTurn and planGeminiTurn now live beside their own provider/runtime
// registrations; only planTurn's dispatch and planHarnessTurn (the Claude Code loop, shared by Kimi, routed
// subscriptions and every endpoint) stay here, since no single provider owns it.

// The schema's own defaults, so an untouched setting can be told from one the owner set to the same value; not restated
// here to avoid a second, driftable copy.
const SETTINGS_DEFAULTS = SandboxSettingsSchema.parse({});

// Bytes of a failed turn-ending command's output forwarded to the model; smaller than the pre-push budget since this
// turn is still running and only needs enough to act on.
const TURN_RULE_OUTPUT_BYTES = 4_000;

// The Claude Code harness: a native Claude turn's subscription OAuth (with mid-turn refresh) or the translator endpoint
// a routed provider rides. Credentials resolve through harness-credentials.ts; its refusals become the connect-gate's
// error here.
export const planHarnessTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnPlan> => {
    // Credential resolution and the settings read run together rather than chained, so a turn later refused for its
    // credential doesn't also pay for an unused settings read first.
    const [resolved, settings, safetyPolicy] = await Promise.all([
        services.perf.track("turn.plan.credentials", { provider: input.agent ?? "claude" }, () =>
            resolveHarnessCredentials(services, {
                agent: input.agent,
                ...(input.account !== undefined ? { account: input.account } : {}),
                ...(input.model !== undefined ? { model: input.model } : {}),
            }),
        ),
        // Per-sandbox agent toggles; stableSystemPrompt keeps the preset prompt byte-stable so the provider prompt
        // cache survives the turn.
        context.settings === undefined
            ? services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get())
            : Promise.resolve(context.settings),
        // Read once here and carried on the request, so a turn is judged against one snapshot rather than three
        // versions of a policy someone is mid-edit on.
        services.safetyPolicy.text(),
    ]);
    if (!resolved.ok) {
        return { ok: false, ...(resolved.code !== undefined ? { code: resolved.code } : {}), message: resolved.message };
    }
    const { oauthToken, refreshOauthToken, endpoint, allowance, trial } = resolved.credentials;
    // Internal tools first, then external mcp-kind capabilities; a same-named external tool overrides, matching
    // mcpServersOf's last-wins merge.
    const tools = [
        ...services.tools,
        ...mcpToolsOf(granted),
        ...peerToolsOf("host", granted, services.config.sandbox.port, services.hostBridgeToken, input.conversationId),
        ...peerToolsOf("webext", granted, services.config.sandbox.port, services.webextBridgeToken),
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
    } = settings;
    // Standing, not matching: conditions are read at Stop, once the turn has actually edited something to narrow on.
    const turnEndingRules = standing(rules, "turn.ending");
    // Rules armed on every file the turn writes, run beside the type check.
    const fileEditedRules = standing(rules, "file.edited");
    // The last planning I/O: an extension scan and the browser bring-up, run together rather than chained.
    // Which persona this turn wears, resolved by planTurn and already applied to `granted`: an unauthorized account is
    // simply absent from it, no server, no Chromium, no open profile. The fallback (open, attended) is only for the
    // bench; a real session always resolves a card first.
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    // The accounts this turn speaks for, feeding both the browser servers and the accounts tools' scope, so a tool can
    // never reach an account the browser was refused.
    const browserAccountIds = granted
        .filter((capability) => capability.kind === "browser" || capability.kind === "identity")
        .map((capability) => capability.id);
    const [extensionAgentDirs, browser, personaKit] = await Promise.all([
        services.perf.track("turn.plan.extensions", {}, () => extensionAgentDirsOf(services)),
        // Browser capabilities grant the one routed @playwright/mcp server, each call bound to its account's persisted
        // profile (or signed in if pending), filtered to this persona's accounts.
        services.perf.track("turn.plan.browser", {}, () =>
            browserServersOf(granted, services.workspace.root, persona.powers.browser, input.conversationId),
        ),
        // The card's own folder (skills, subagents, tools), loaded as a plugin dir; undefined for an unpinned turn or a
        // card with no kit.
        persona.persona === undefined ? Promise.resolve(undefined) : personaKitPlugin(services.workspace.root, persona.persona.id),
    ]);
    // The image-baked iq plugin loads ahead of any user plugin so the agent prefers it for code search, gated by the
    // per-sandbox iqSearch toggle (opt-in, off by default); an empty dir outside the container is skipped regardless.
    // Resolved once and read twice (the plugin list, and the request's `iqAvailable`), so the empty-search notice and
    // the actual load can't disagree the way two separate derivations of the same condition could.
    const iqLoaded = services.config.iqPluginDir !== "" && (context.iqSearchEnabled ?? iqSearch);
    const plugins = [
        ...(iqLoaded ? [services.config.iqPluginDir] : []),
        // Rides ungated: the CLI is always on PATH, and the skill keeps an agent from WebFetch-looping a page it could
        // read in one webq call.
        ...(services.config.webqPluginDir !== "" ? [services.config.webqPluginDir] : []),
        ...pluginDirsOf(granted, services.workspace.root),
        ...extensionAgentDirs,
        // Last, since it's the most specific thing this turn carries; an ordering, not an override, since the loader
        // namespaces each plugin's skills by name.
        ...(personaKit === undefined ? [] : [personaKit]),
    ];
    // Turn-scoped roots follow the effective cwd; browser profiles, plugin checkouts and attachments stay on /work as
    // absolute inputs, not edit targets.
    const dependencyTitle = input.conversationId === undefined ? input.title : services.agents.entry(input.conversationId)?.title;
    // The one object behind every secret seam this turn gets: the named registry and the use ledger its exits feed.
    // `used` is fire-and-forget, since a ledger write must never fail or slow the tool call that spent the secret.
    const secretAccess: SecretAccess = {
        list: services.secretRegistry,
        used: (use) => {
            void services.secretUses
                .record({ ...use, at: Date.now() })
                .catch((error: unknown) => services.logger.warn({ err: error, secret: use.name }, "secret use record failed"));
        },
        // The approval gate bound to this turn. One card per subject, not per secret name: a command naming two secrets
        // of the same credential is one decision, and different subjects are asked one after another rather than
        // batched onto one card.
        release: async (names, lane, detail) => {
            if (names.length === 0) {
                return { ok: true };
            }
            const bySubject = new Map<string, { readonly kind: CredentialGateKind; readonly names: string[] }>();
            for (const name of names) {
                const { subject, kind } = gateTargetOf(name);
                const entry = bySubject.get(subject);
                if (entry === undefined) {
                    bySubject.set(subject, { kind, names: [name] });
                    continue;
                }
                entry.names.push(name);
            }
            const approvedBy: Record<string, string> = {};
            for (const [subject, { kind, names: covered }] of bySubject) {
                const verdict = await services.credentialGate.check({
                    subject,
                    kind,
                    lane,
                    detail,
                    conversationId: input.conversationId,
                    unattended: input.unattended === true,
                    signal: context.base.signal,
                });
                if (!verdict.allow) {
                    return { refusal: verdict.reason };
                }
                if (verdict.approvedBy !== undefined) {
                    for (const name of covered) {
                        approvedBy[name] = verdict.approvedBy;
                    }
                }
            }
            return Object.keys(approvedBy).length > 0 ? { ok: true, approvedBy } : { ok: true };
        },
    };
    const sdkServers = {
        ...browser.servers,
        // The browser exit for stored secrets: types a named value into a live page's focused field. Mounted only when
        // this turn drives a browser at all; its scope is exactly the turn's own browser list.
        ...(Object.keys(browser.servers).length > 0
            ? {
                  secrets: secretsServer({
                      secrets: secretAccess,
                      accounts: { ...browser.accounts, ...("web" in browser.servers ? { web: "web" } : {}) },
                  }),
              }
            : {}),
        // hashlineEdits swaps the native Edit/Write (disabled below) for hash-anchored file tools.
        ...(hashlineEdits ? { hashline: createHashlineServer(context.localCwd) } : {}),
        // The `wait` tool parks until a child of this turn settles, and `spawn` (same server) starts a full agent on
        // any connected provider; always offered, since a turn that spawns nothing simply never calls it. Withheld
        // without the delegate shelf and full agency.
        subagents: subagentWaitServer({
            conversationId: context.base.conversationId,
            signal: context.base.signal,
            ...(context.children !== undefined && persona.powers.delegate && persona.powers.shell && persona.powers.files === "write"
                ? { children: context.children }
                : {}),
        }),
        // The condition watch: the agent names an outside check command the daemon polls, waking the conversation when
        // it exits 0 — a replacement for hand-rolled sleep loops and the CLI's own scheduling, which can't fire once
        // the turn's process is gone. Withheld without shell power or a conversation to wake.
        ...(persona.powers.shell && input.conversationId !== undefined
            ? {
                  watch: watchServer({
                      conversationId: input.conversationId,
                      cwd: context.localCwd,
                      // The base's persona-filtered env, for the same reason shellEnv below reads it: a check must not
                      // run with a credential the card withheld.
                      env: context.base.cliEnv ?? {},
                      turn: watchSeed(input),
                  }),
              }
            : {}),
        // Dependency readiness asked of the main checkout: an isolated turn's dependencies live in /work and are only
        // mounted into its namespace, so /work's answer is the turn's answer.
        deps: createDepsServer({
            dependencies: services.dependencies,
            canInstall: persona.powers.files === "write" && persona.powers.shell,
            origin: {
                kind: "request",
                ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
                ...(dependencyTitle === undefined ? {} : { title: dependencyTitle }),
            },
        }),
        // The daemon's own records (failures, slow work, outcomes, resources), read-only and scoped to historyRoot/logs
        // and the spend ledger. Gated on `files` rather than its own power, and withheld whole from a `none` card.
        ...(persona.powers.files === "none"
            ? {}
            : { diagnostics: createDiagnosticsServer({ historyRoot: services.config.historyRoot, usage: services.usage }) }),
    };
    // The base's env, not the raw context one: `honoured` already withheld ungranted connector credentials there, and
    // rebuilding from the raw env would hand them all back to this arm alone.
    const shellEnv = { ...context.base.cliEnv };
    // The turn's user message, with the attachment note folded in as before.
    const promptWithAttachments =
        context.attachmentPaths.length > 0 ? withAttachmentNote(context.base.prompt, [...context.attachmentPaths]) : context.base.prompt;
    // A leading `/` naming no real command would otherwise be silently discarded by the CLI ("Unknown command"); the
    // note keeps the user's words in front of the model. Last of the notes, so the guard still sees the `/` at the very
    // start of the composed prompt.
    const literalSlash = isUnknownSlashCommand(input.agent ?? "claude", promptWithAttachments);
    const prompt = promptWithAttachments;
    const notes = literalSlash ? [...(context.base.notes ?? []), LITERAL_SLASH_NOTE] : context.base.notes;
    // Fast speed is a native-turn ask, held back from a routed turn under this loop: the harness refuses fast mode on a
    // non-first-party endpoint, so forwarding it would report `not_first_party` for nothing. Split off since the
    // field's absence, not `fast: undefined`, is the meaning.
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
            // A routed turn pins the translator endpoint, bearer and mapped model and drops the Anthropic OAuth token;
            // a native Claude turn keeps its token, may go fast, and falls back to the daemon-wide default model when
            // the turn pinned none.
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
            // The same directory the browser servers got as --output-dir, so the model-named-screenshot hook redirects
            // into it from one shared source. Omitted when no browser servers were wired.
            ...(Object.keys(browser.servers).length > 0 ? { browserOutputDir: browserOutputDir(services.workspace.root) } : {}),
            // Whether the diagnostics server was mounted, so the prompt names its tools only where they can actually be
            // called.
            ...(sdkServers.diagnostics === undefined ? {} : { diagnostics: true }),
            // Whether this turn actually carries the iq plugin, so the empty-`rg` notice names iq only where it's real.
            iqAvailable: iqLoaded,
            // Debugging ports for those Chromiums, so the first browser call can register a session the owner can
            // watch.
            ...(Object.keys(browser.ports).length > 0 ? { browserPorts: browser.ports } : {}),
            // Each logged-in profile's passkey store, so the observer plugs the platform's software security key into
            // it.
            ...(Object.keys(browser.passkeys).length > 0 ? { browserPasskeys: browser.passkeys } : {}),
            // The routed server's account→owner map, so the observer resolves a call's `account` argument to its
            // profile.
            ...(Object.keys(browser.accounts).length > 0 ? { browserAccounts: browser.accounts } : {}),
            // Accounts tools ride whenever this turn has browser accounts; the very set of accounts whose servers were
            // just mounted is the scope those tools enforce.
            ...(browserAccountIds.length > 0
                ? {
                      accountsServer: accountsServer({
                          capabilities: services.capabilities,
                          root: services.workspace.root,
                          accounts: browserAccountIds,
                          ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
                          attended: input.unattended !== true,
                          // The two verbs past the narrow deps (filing a new account, reading a mailbox code), injected
                          // as closures so the tools stay testable without Services or a network.
                          openAccount: (request) => openBrowserAccount(services, request),
                          fetchCode: fetchEmailCode,
                          release: async (account, lane, detail) => {
                              const verdict = await services.credentialGate.check({
                                  subject: account,
                                  kind: "capability",
                                  lane,
                                  detail,
                                  conversationId: input.conversationId,
                                  unattended: input.unattended === true,
                                  signal: context.base.signal,
                              });
                              return verdict.allow ? { ok: true } : { refusal: verdict.reason };
                          },
                      }),
                  }
                : {}),
            // hashlineEdits owns file mutation via its own MCP server, so native Edit/Write are dropped (Read stays,
            // for viewing images/PDFs).
            ...(hashlineEdits ? { disallowedTools: ["Edit", "Write"] } : {}),
            // Forwards the Bash output-cleaner spec and the holdout fraction; empty string omits it, letting the
            // filter's own all-on default apply.
            ...(outputCleaners !== "" ? { outputCleaners } : {}),
            ...(outputHoldout > 0 ? { outputHoldout } : {}),
            // Every stored credential masked to its `{{secret:name}}` reference in tool results, unconditional since,
            // unlike the cleaners, this isn't a saving worth trading away.
            secrets: secretAccess,
            // The heavy-command queue, forwarded only where the image can enforce it (bin/queue-run on PATH), else a
            // rewritten line would name a binary that isn't there. A reader, not a snapshot, since the file is edited
            // live while someone watches the box.
            ...(queueRunEnabled() ? { heavyCommands: () => services.heavyCommands.read() } : {}),
            ...(Object.keys(shellEnv).length > 0 ? { cliEnv: shellEnv } : {}),
            // Forwarded only where the owner actually moved a cap: an untouched one is left for the harness to answer,
            // since the nesting cap's real default is remote-config'd inside the CLI and restating today's value would
            // pin it.
            ...(subagentsAtOnce !== SETTINGS_DEFAULTS.subagentsAtOnce ? { subagentsAtOnce } : {}),
            ...(subagentsPerTurn !== SETTINGS_DEFAULTS.subagentsPerTurn ? { subagentsPerTurn } : {}),
            ...(subagentDepth !== SETTINGS_DEFAULTS.subagentDepth ? { subagentDepth } : {}),
            // Every image-scoped install attempt, appended best-effort to the runtime-install ledger; a second distinct
            // session installing the same tool is what earns an auto-drafted overlay step.
            onImageInstall: (installs, command) => {
                void services.runtimeInstalls
                    .record(installs, command, input.conversationId, Date.now())
                    .catch((error: unknown) => services.logger.warn({ err: error }, "runtime-install ledger append failed"));
            },
            // Forwarded only when rules exist, so a workspace with none wires no hooks. Conditions aren't read here
            // since the turn hasn't run yet; turn-ending.ts reads them at Stop instead, in the turn's own cwd.
            // Which files the tree says are dirty, both names, for a shell command's edit diagnostics. Read on every
            // turn: the main checkout's standing dirty set is everyone's landed work and a baseline, not a finding,
            // there.
            dirtyFiles: async () =>
                (await dirtyPathsAcross(context.localCwd, await discoverRepos(context.localCwd))).map((path) => {
                    const onDisk = join(context.localCwd, path);
                    return { onDisk, path: fromWorktree(onDisk, context.base.isolation?.plan) };
                }),
            // The `file.edited` moment as one reviewer per written file, run where the Stop's command would run and
            // named as the agent sees it. Firings stamp the settings list only, so a per-edit rule doesn't spam a feed
            // row per save.
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
                      // The verdict, told to two readers at the moment each wants it (the land takes it once; the card
                      // reads the registry after), rather than one forwarding to the other, since the first to want it
                      // would destroy it for the second.
                      ...(conversation === undefined
                          ? {}
                          : {
                                onCheckRun: (rule: Rule, run: RuleCommandRun) => {
                                    recordCheckVerdict(conversation, rule, run);
                                    // Only a settled failure counts: `error` never ran and `cancelled` was cut short,
                                    // neither measured the work.
                                    services.agents.noteCheck(conversation, { label: rule.label, failed: run.status === "failed" });
                                },
                            }),
                      // A rule that fires here continued a turn the model had finished; stamped to the settings list
                      // and the feed, both best-effort since the turn must settle regardless.
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
                      // What the follow-up bought, in counts, so the rule's cost can be weighed against what it changed.
                      onFollowUpOutcome: (rule: Rule, outcome: FollowUpOutcome) => {
                          const did = [
                              outcome.edits > 0 ? `${outcome.edits} edit${outcome.edits === 1 ? "" : "s"}` : undefined,
                              outcome.looks > 0 ? `${outcome.looks} look${outcome.looks === 1 ? "" : "s"} at the page` : undefined,
                              outcome.commands > 0 ? `${outcome.commands} command${outcome.commands === 1 ? "" : "s"}` : undefined,
                          ].filter((part) => part !== undefined);
                          void services.activity
                              .append({
                                  direction: "system",
                                  type: "rule.followup_outcome",
                                  content: `"${rule.label}" was answered with ${did.length === 0 ? "no edit, no look and no command" : did.join(", ")}.`,
                                  extra: { rule: rule.id, ...outcome },
                                  ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
                              })
                              .catch((error: unknown) => services.logger.warn({ err: error, rule: rule.id }, "rule outcome append failed"));
                      },
                      // Logged like the pre-push check, since a red `turn.ending` command has two very different causes
                      // (broken work, or a check that never saw the workspace's dependencies) told apart only by
                      // whether it ran anchored in the turn's namespace.
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
                      // Asked only after a command has failed, so a healthy turn pays nothing: a check run mid-install
                      // isn't a verdict on the work.
                      dependencyInstalling: async () =>
                          (await services.dependencies.status())
                              .filter((project) => project.state === "installing")
                              .map((project) => (project.dir === "" ? "the workspace root" : project.dir)),
                      // What the tree says the turn changed, for the Stop's conditions; an edit via `sed -i` or a
                      // script is invisible to the edit ledger but not to git. Only for an isolated turn, whose
                      // worktree starts clean, so its dirty paths are its own.
                      ...(context.localCwd !== services.workspace.root
                          ? {
                                changedPaths: async () => dirtyPathsAcross(context.localCwd, await discoverRepos(context.localCwd)),
                                // The verify-tests built-in, over the same dirty set, only here: in the main checkout
                                // those test files are everyone's, and reverting one to measure this turn's fault check
                                // would touch a sibling agent's work.
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
            // The sniffer's rulebook, forwarded only when the owner wrote a rule, the same no-hook economy as above.
            ...(Object.keys(actionRules).length > 0 ? { actionRules } : {}),
            // Wired unconditionally, unlike the sniffer's rulebook: triage and the hard rule are facts about the
            // command, not the owner's configuration. Both the policy text and the judge are snapshots taken here, for
            // one document and one model per turn.
            safetyPolicy,
            judging: settings.commandJudge,
            judge: judgeFor(services, safetyPolicy, settings.modelRoles[`safety-judge`]),
            logSafety: (entry) => {
                void services.safetyLog.record(entry).catch(() => undefined);
            },
            safetyAnswered: (at, answer, outcome) => {
                void services.safetyLog.answered(at, answer, outcome).catch(() => undefined);
            },
            rememberSafety: (line) => services.safetyPolicy.append(line),
            // Whether outside content caused this turn (a listener or webchat wake is a stranger's message), the same
            // distinction the admission floor draws, read here for the taint the command gate consults.
            ...(input.outsideWake !== undefined ? { outsideWake: input.outsideWake } : {}),
            // Mid-turn steering (the /agent/steer queue streamAgent registered); Claude Code harness only.
            ...(context.steering !== undefined ? { steering: context.steering } : {}),
            // The rebase the cards take back while the user is answering them; isolated turns only.
            ...(context.resync !== undefined ? { resync: context.resync } : {}),
        },
    };
};
