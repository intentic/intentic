import {
    type AgentSearchResult,
    type AgentSummary,
    type AttachFrame,
    type DeviceFlowLine,
    type Info,
    isTurnBreakPolicy,
    type ConversationPrompt,
    type Persona,
    type Area,
    type Model,
    type OauthAccount,
    type PresenceUser,
    REPO_CHECKS_FILE,
    type RepoChecksList,
    type SandboxHandlerInput,
    type SandboxHandlerOutput,
    type SavingsReport,
    type SystemEvent,
    type TranslatorAccounts,
    type WorkflowRun,
} from "@intentic/sandbox-contract";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { KNOWLEDGE_BASE } from "../vendor/knowledge/wire-types";
import { BROWSER_SESSIONS } from "./browser";
import { type DemoGrant, grantAccess, grants, revokeAccess } from "./fixture/access";
import { automationApprovals, automationCatalog, automationsList, deleteAutomation, resolveApproval, saveAutomation } from "./fixture/automations";
import { demoDevices } from "./fixture/devices";
import { demoMetrics } from "./fixture/metrics";
import { demoStorageClean, demoStorageReport, demoStorageScan } from "./fixture/storage";
import { demoLoops } from "./fixture/loops";
import { demoRuns, demoWorkflows } from "./fixture/workflows";
import { choresReport, writeLedger } from "./fixture/chores";
import { ciJobs, ciRunsResponse } from "./fixture/ci";
import { MAKER_AWAITING_ID, MAKER_FEATURED_ID, MAKER_SANDBOX_NAME, makerRoster, SUPPLIER_LETTER_DOCX, SUPPLIER_LETTER_PATH } from "./fixture/maker";
import { AWAITING_AGENT_ID, FEATURED_AGENT_ID, fleetRoster } from "./fixture/fleet";
import {
    deleteKnowledgeNote,
    knowledgeGraph,
    knowledgeNoteAt,
    knowledgeNotes,
    knowledgeOverview,
    knowledgeSearch,
    saveKnowledgeNote,
} from "./fixture/knowledge";
import { demoRegistry } from "./fixture/registry";
import {
    demoCapabilities,
    demoLocalModelFit,
    demoStartPrefetch,
    demoEnvironment,
    demoEnvironmentContents,
    demoExtensions,
    demoPanels,
    demoUsageRollup,
    setExtensionEnabled,
    vendoredBundle,
} from "./fixture/sandbox";
import { HANDOVER_CHANGE_PATH, HANDOVER_DOCX, HANDOVER_DOCX_BEFORE, HANDOVER_PATH, HANDOVER_TEXT, HANDOVER_TEXT_BEFORE } from "./fixture/document";
import { transcriptFor } from "./fixture/transcripts";
import {
    agentChanges,
    deleteEntry,
    fileBody,
    fileDiff,
    gitChanges,
    landAgentDelta,
    landedPaths,
    readFile,
    PUBLISH_REFUSAL,
    REMOTE_REPOS,
    REPOS,
    searchWorkspace,
    sessions,
    workspaceChildren,
    workspaceTree,
    writeFile,
} from "./fixture/workspace";
import { demoMode, makerEdition } from "./mode";
import { coverageOf, type FixtureRouter, Frames, type RawContext, type RawRoutes, refuse, serve } from "./router";
import { featuredRun, type Run, visitorRun } from "./turn";
import { json } from "./transport";

// The daemon the demo stands in for, as a typed fixture router (router.ts): every procedure it serves answers in its
// contract's types, so a shape that drifts from the wire is a build error, and every other route the app reaches is a
// raw route answered by hand. The live state below is what the mutations write and the `/events` stream re-broadcasts.

const STARTED_AT = Date.now();

// Which recording's two special cards this page serves: the run with a script behind it, and the one parked on a question.
const FEATURED_ID = makerEdition ? MAKER_FEATURED_ID : FEATURED_AGENT_ID;
const AWAITING_ID = makerEdition ? MAKER_AWAITING_ID : AWAITING_AGENT_ID;

// Live state; every write bumps `rev` and re-broadcasts (snapshot-not-diff, newest rev wins).
const roster = {
    agents: makerEdition ? makerRoster(STARTED_AT) : fleetRoster(STARTED_AT).filter((agent) => demoMode.agents?.includes(agent.id) ?? true),
    rev: 1,
};

// Held automation approvals project onto the board's attention lane; a maker runs no automations.
const heldApprovals = () => (makerEdition ? [] : automationApprovals(Date.now()));
const listeners = new Set<(event: SystemEvent) => void>();
const runs = new Map<string, Run>();

const broadcastRoster = (): void => {
    roster.rev += 1;
    const frame: SystemEvent = { kind: `agents`, agents: roster.agents, rev: roster.rev };
    for (const listener of listeners) {
        listener(frame);
    }
};

// Filters runs to steps whose still-running agent is on this board's roster; a board missing an agent
// must not see the run it's a step of.
const runsOnBoard = (now: number): WorkflowRun[] =>
    demoRuns(now).filter((run) =>
        run.steps.every((step) => step.state !== `running` || roster.agents.some((agent) => agent.id === step.conversationId)),
    );

const patchAgent = (id: string, patch: Partial<AgentSummary>): AgentSummary | undefined => {
    const index = roster.agents.findIndex((agent) => agent.id === id);
    const found = roster.agents[index];
    if (found === undefined) {
        return undefined;
    }
    const next = { ...found, ...patch };
    roster.agents = roster.agents.with(index, next);
    broadcastRoster();
    return next;
};

// The answer every card route gives: the card as it now stands, or the daemon's refusal for an id it does not hold.
const agentAnswer = (agent: AgentSummary | undefined): AgentSummary => agent ?? refuse(`No such agent.`, 404);

// The two demo presence users; TEAMMATE alone tells the whole sharing story.
const OWNER: PresenceUser = { clientId: `demo-owner`, email: `ada@acme.dev`, name: `Ada Lovelace`, role: `owner`, idle: false, view: `workspace` };
const TEAMMATE: PresenceUser = {
    clientId: `demo-mate`,
    email: `grace@acme.dev`,
    name: `Grace Hopper`,
    role: `collaborator`,
    idle: true,
    view: `agents`,
};

// Heartbeat interval for /events, inside the browser's 10s watchdog.
const HEARTBEAT_MS = 2_000;

// Interval for a synthetic `runtimeChanged` push, since the fixture's data doesn't change on its own.
const RUNTIME_TICK_MS = 10_000;

const events = (): Frames<SystemEvent> =>
    new Frames((sink) => {
        const listener = (event: SystemEvent): void => sink.emit(event);
        listeners.add(listener);

        sink.emit({ kind: `hello`, workspaceId: `demo-workspace`, build: `demo`, boot: { ready: true, startedAt: STARTED_AT, steps: [] } });
        sink.emit({ kind: `agents`, agents: roster.agents, rev: roster.rev });
        sink.emit({ kind: `reposChanged`, repos: [...REPOS] });
        sink.emit({ kind: `presence`, users: demoMode.teammate ? [OWNER, TEAMMATE] : [OWNER] });

        const beat = setInterval(() => sink.emit({ kind: `heartbeat`, rev: roster.rev }), HEARTBEAT_MS);
        const runtime = setInterval(
            () => sink.emit({ kind: `runtimeChanged`, domains: [`terminals`, `browsers`, `panels`, `ports`, `subagents`] }),
            RUNTIME_TICK_MS,
        );
        return () => {
            clearInterval(beat);
            clearInterval(runtime);
            listeners.delete(listener);
        };
    });

/** The featured turn, created on first attach so its clock starts when the visitor actually arrives. */
const runFor = (conversationId: string): Run | undefined => {
    const existing = runs.get(conversationId);
    if (existing !== undefined) {
        return existing;
    }
    if (conversationId !== FEATURED_ID) {
        return undefined;
    }
    const run = featuredRun(conversationId, Date.now());
    runs.set(conversationId, run);
    return run;
};

const attach = (conversationId: string): Frames<AttachFrame> => {
    const run = runFor(conversationId);
    if (run === undefined) {
        // Nothing is running on this conversation, the same empty stream a real daemon answers with.
        return new Frames((sink) => {
            sink.emit({ kind: `end` });
            sink.close();
            return () => {};
        });
    }
    return new Frames((sink) => {
        run.attach(sink);
        return () => {};
    });
};

// One device agent's update or restart, in the frames the real flow sends: `line` for progress, `result` for what the
// machine says at the end. Paced so a press is watchable rather than over before the row has drawn its log.
const AGENT_STEP_MS = 450;
const agentFlow = (id: string, op: string): Frames<DeviceFlowLine> => {
    const said =
        op === `restart`
            ? { lines: [`Stopping the agent loop on ${id}.`], result: `The agent loop was restarted on this device.` }
            : {
                  lines: [`Downloading the current agent (1.275.0)…`, `  100% of 87 MB`, `Swapping the binary and restarting the loop.`],
                  result: `Already on the current agent (1.275.0). Nothing to do.`,
              };
    return new Frames((sink) => {
        let step = 0;
        const timer = setInterval(() => {
            const line = said.lines[step];
            if (line !== undefined) {
                sink.emit({ kind: `line`, text: line });
                step += 1;
                return;
            }
            sink.emit({ kind: `result`, message: said.result });
            sink.close();
        }, AGENT_STEP_MS);
        return () => clearInterval(timer);
    });
};

// Prefixes for the rail's isolated extension runs (xt-/dg-/mt-), refused here; a prefixless run still works.
const EXTENSION_RUN_PREFIXES = [`xt-`, `dg-`, `mt-`];

const startTurn = ({ conversationId = FEATURED_ID, prompt }: SandboxHandlerInput<`agent`, `run`>): { delivered: `started`; run: string } => {
    if (EXTENSION_RUN_PREFIXES.some((prefix) => conversationId.startsWith(prefix))) {
        return refuse(`This is the demo workspace: a run needs your repositories and a sandbox to walk them in. Start one and this button works.`);
    }
    runs.get(conversationId)?.stop();
    const run = visitorRun(conversationId, prompt, Date.now());
    runs.set(conversationId, run);
    // As the daemon derives them (agents-registry summaryOf): a live turn has nothing parked, and a refused land's flag
    // and causes follow the `conflict` status the turn replaces, so they go with it.
    patchAgent(conversationId, {
        status: `running`,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        conflictCauses: undefined,
    });
    return { delivered: `started`, run: run.id };
};

const reply = (answer: SandboxHandlerInput<`agent`, `reply`>): { ok: true } => {
    for (const run of runs.values()) {
        run.resolve(answer.requestId, answer);
    }
    // The card that was parked belongs to the agent whose attention flag raised it: answering clears it.
    patchAgent(AWAITING_ID, {
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    return { ok: true };
};

const stopTurn = ({ conversationId }: SandboxHandlerInput<`agent`, `stop`>): { stopped: boolean } => {
    const run = runs.get(conversationId);
    run?.stop();
    patchAgent(conversationId, { status: `stopped`, updatedAt: Date.now() });
    return { stopped: run !== undefined };
};

// Moves the agent's delta into the main tree on success (fixture/workspace.ts) and broadcasts
// `workspaceChanged`; on failure, flips the card to conflict with the check's report.
const land = (id: string): ReturnType<typeof landAgentDelta> => {
    const result = landAgentDelta(id);
    if (!result.landed) {
        patchAgent(id, {
            status: `conflict`,
            updatedAt: Date.now(),
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: true },
        });
        return result;
    }
    patchAgent(id, {
        status: `landed`,
        updatedAt: Date.now(),
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    const paths = landedPaths(id);
    for (const listener of listeners) {
        listener({ kind: `workspaceChanged`, paths });
    }
    return result;
};

// One answer per ending, as the daemon stores it: `null` clears the override back to the sandbox-wide policy.
// Real, not a stub, so the chat's own control and the card's menu behave here exactly as they do against a daemon.
const setBreakPolicy = ({ id, ending, policy }: SandboxHandlerInput<`agents`, `breakPolicy`>): AgentSummary => {
    if (policy !== null && !isTurnBreakPolicy(ending, policy)) {
        return agentAnswer(undefined);
    }
    const key = ending === `limit` ? `limitPolicy` : ending === `outage` ? `outagePolicy` : `stopPolicy`;
    return agentAnswer(patchAgent(id, { [key]: policy ?? undefined }));
};

// The demo's own reader is Ada (the session this daemon mints), so a press here joins or leaves her from the chip,
// exactly as the real one attributes a mark to the verified caller rather than to anything the browser sent.
const reactToAgent = ({ id, emoji, on }: SandboxHandlerInput<`agents`, `react`>): AgentSummary => {
    const agent = roster.agents.find((candidate) => candidate.id === id);
    if (agent === undefined) {
        return agentAnswer(undefined);
    }
    const me = { email: OWNER.email, ...(OWNER.name === undefined ? {} : { name: OWNER.name }), at: Date.now() };
    // Only the pressed emoji is rewritten: her marks on the other chips are not what this press was about.
    const held = agent.reactions ?? [];
    const opened = on && !held.some((chip) => chip.emoji === emoji) ? [...held, { emoji, by: [] }] : held;
    const marked = opened.map((chip) => {
        if (chip.emoji !== emoji) {
            return chip;
        }
        const without = chip.by.filter((who) => who.email !== OWNER.email);
        return { ...chip, by: on ? [...without, me] : without };
    });
    const reactions = marked.filter((chip) => chip.by.length > 0);
    return agentAnswer(patchAgent(id, reactions.length > 0 ? { reactions } : { reactions: undefined }));
};

// Changes hands as the real route does: a name is known only for the reader's own address; anyone else is an address
// until presence says otherwise.
const assignAgent = ({ id, to }: SandboxHandlerInput<`agents`, `assign`>): AgentSummary => {
    const address = to.trim().toLowerCase();
    if (address === ``) {
        return refuse(`An address is required.`, 400);
    }
    const name = address === OWNER.email.toLowerCase() ? OWNER.name : undefined;
    return agentAnswer(patchAgent(id, { owner: { email: address, ...(name === undefined ? {} : { name }), since: Date.now() } }));
};

const archiveAgents = ({ ids = [] }: SandboxHandlerInput<`agents`, `archive`>): { moved: AgentSummary[]; failed: []; rev: number } => {
    const archivedAt = Date.now();
    const archived: AgentSummary[] = [];
    for (const agent of roster.agents) {
        if (ids.includes(agent.id)) {
            archived.push({ ...agent, archivedAt });
        }
    }
    roster.agents = roster.agents.filter((agent) => !ids.includes(agent.id));
    broadcastRoster();
    // Answers `moved`/`failed`, the daemon's own shape (AgentsArchivedSchema).
    return { moved: archived, failed: [], rev: roster.rev };
};

/** A mutation with nothing to report: do it, then answer the daemon's own `{ ok: true }`. */
const okAfter = (write: () => void): { ok: true } => {
    write();
    return { ok: true };
};

// Honors the search field's case-sensitivity switch, matching the browser's own tier.
const folded = (text: string, caseSensitive: boolean): string => (caseSensitive ? text : text.toLowerCase());

const searchAgents = (query: string, caseSensitive: boolean): AgentSearchResult => {
    const needle = folded(query.trim(), caseSensitive);
    const matches =
        needle === ``
            ? []
            : roster.agents.filter((agent) => folded(agent.title ?? ``, caseSensitive).includes(needle)).map((agent) => ({ id: agent.id }));
    // No phrase index behind this; nothing is ever still being indexed.
    return { matches, scanned: roster.agents.length, indexing: false };
};

const searchSessions = (query: string, caseSensitive: boolean): ReturnType<typeof sessions> => {
    const all = sessions(Date.now());
    const needle = folded(query.trim(), caseSensitive);
    return needle === `` ? all : all.filter((session) => folded(session.title, caseSensitive).includes(needle));
};

// Upsert by id, as the daemon's `/personas` does; the list is the store, so a saved card is in the next read.
// Where each starts is what decides who may talk to it (policy/persona-home.ts), so the three cards cover the three
// answers: one homed in each area below, and one at the root that only an unfenced person reaches.
const demoPersonas: Persona[] = [
    { id: `maya-support`, label: `Maya · Customer Care`, capabilities: [`gmail-support`, `intercom`], workspace: { startIn: `web/support` } },
    { id: `owen-growth`, label: `Owen · Growth`, capabilities: [`x-brand`, `linkedin`], workspace: { startIn: `web/site` } },
    { id: `priya-ops`, label: `Priya · Operations`, capabilities: [`github`, `stripe-ops`] },
];
const savePersona = (card: Persona): void => {
    const index = demoPersonas.findIndex((persona) => persona.id === card.id);
    if (index === -1) {
        demoPersonas.push(card);
    } else {
        demoPersonas[index] = card;
    }
};

// The named parts of the workspace, upserted like the personas above: two, so a picker shows both the fence and
// what it leaves out.
const demoAreas: Area[] = [
    { id: `support`, label: `Support maker`, brief: `Tickets, replies and the help centre.`, folders: [`web/support`] },
    { id: `site`, label: `Marketing site`, folders: [`web/site`] },
];
const saveArea = (area: Area): void => {
    const index = demoAreas.findIndex((entry) => entry.id === area.id);
    if (index === -1) {
        demoAreas.push(area);
    } else {
        demoAreas[index] = area;
    }
};
// Refused while a demo member still holds it, as the daemon refuses one: the demo roster is the fixture's own.
const removeArea = (id: string): void => {
    const index = demoAreas.findIndex((entry) => entry.id === id);
    if (index !== -1) {
        demoAreas.splice(index, 1);
    }
};

const info: Info = { name: makerEdition ? MAKER_SANDBOX_NAME : `acme-shop`, version: `demo`, latest: `demo`, updateAvailable: false };

// The handshake `state` a routed sign-in issues; ConnectFlow only accepts a pasted address carrying this one.
const DEMO_CONNECT_STATE = `demo-connect-state`;

// One version of the document as the text a daemon's fileq would render from it (the diff's Text reading).
const derivedSide = (content: string) => ({ present: true as const, content, deriver: `docx v2`, notes: [], truncated: false });

// Every procedure the fixture serves; an empty-but-real area answers its contract's empty shape, not a 404.
export const procedures = {
    system: {
        events,
        info: () => info,
        session: () => ({ token: `demo-session`, expiresAt: Date.now() + 30 * 24 * 3_600_000, email: `ada@acme.dev` }),
        presence: () => ({ ok: true }),
        usage: () => ({ accounts: [] }),
        // Asked only while the board is open with geek metrics on; it drifts per request, so the polling is visible.
        metrics: () => demoMetrics(Date.now(), roster.agents),
        // The Overview's Disk card: a scan already on hand, a rescan on request, and a clean that frees its category.
        storage: () => demoStorageReport(),
        scanStorage: () => demoStorageScan(Date.now()),
        cancelStorageScan: () => ({ ok: true }),
        cleanStorage: ({ category }) => demoStorageClean(category),
        terminals: () => ({
            sessions: [{ name: `agent-checkout-stripe`, label: `checkout-stripe`, kind: `agent`, running: true, activityAt: Date.now() }],
        }),
        // One still-driven browser session and one already closed, rendered as history, not a broken stream.
        browsers: () => ({ sessions: BROWSER_SESSIONS(Date.now()) }),
        // The owner's own computers. Without this the Devices tab could only say it had nothing to show, so nothing
        // under a paired folder — the sync switches, and the two answers to a conflict — was ever drawn.
        devices: () => ({ devices: demoDevices(Date.now()) }),
        // The agent's own two verbs, streamed as the daemon streams them: progress lines, then the machine's sentence.
        // Each environment of a PC answers for itself, which is what a machine-wide update walks through — without this
        // the only state that page could show was the refusal of a route nobody serves.
        runDeviceAgentFlow: ({ id, op }) => agentFlow(id, op),
        closeBrowser: () => refuse(`This is the demo workspace: the browser you are watching is a recording, so there is nothing to close.`),
        subagents: () => ({ sessions: [] }),
    },
    agents: {
        // `held` mirrors /automations/pending's approval queue, projected onto the board.
        list: () => ({ agents: roster.agents, rev: roster.rev, held: heldApprovals() }),
        archived: () => ({ agents: [], rev: roster.rev, held: [] }),
        search: ({ query, caseSensitive }) => searchAgents(query, caseSensitive === true),
        seenAll: () => ({ agents: roster.agents, rev: roster.rev, held: heldApprovals() }),
        diff: ({ id }) => agentChanges(id),
        // A card that is not mid-turn reads its transcript instead of attaching.
        transcript: ({ id }) => transcriptFor(id),
        systemPrompt: () => DEMO_SYSTEM_PROMPT,
        fileDiff: ({ repo, path }) => fileDiff(repo, path),
        rename: ({ id, title }) => agentAnswer(patchAgent(id, { title })),
        seen: ({ id }) => agentAnswer(patchAgent(id, { seenAt: Date.now() })),
        react: reactToAgent,
        assign: assignAgent,
        autoLand: ({ id }) => agentAnswer(patchAgent(id, {})),
        breakPolicy: setBreakPolicy,
        land: ({ id }) => land(id),
        discard: () => refuse(`This is the demo workspace: there is no worktree to discard.`),
        archive: archiveAgents,
        unarchive: () => ({ moved: [], rev: roster.rev }),
    },
    agent: {
        run: startTurn,
        attach: ({ conversationId }) => attach(conversationId),
        reply,
        steer: () => ({ delivered: `steered` as const }),
        stop: stopTurn,
        commands: () => ({ commands: DEMO_COMMANDS }),
        refusals: () => ({ refusals: {} }),
    },
    sessions: {
        list: ({ query = ``, caseSensitive }) => ({ sessions: searchSessions(query, caseSensitive === true) }),
        get: () => ({ messages: [] }),
    },
    // Serves the recording's filesystem like the real daemon: a tree, lazy per-directory listing, and real
    // writes that hold until the tab reloads.
    workspace: {
        tree: () => workspaceTree(),
        children: ({ path }) => workspaceChildren(path),
        // A missing path answers "nothing there" in a 200 body, not a 404; several surfaces read a file just to
        // check existence.
        file: ({ path }) => readFile(path),
        delete: ({ path }) => okAfter(() => deleteEntry(path)),
        repos: () => ({ repos: [...REPOS] }),
        search: ({ query, mode, literal, word, caseSensitive, include = ``, dir = `` }) =>
            searchWorkspace(query, { smart: mode === `q`, literal: literal === true, word: word === true, caseSensitive: caseSensitive === true, include, dir }),
    },
    git: {
        repos: () => ({ repos: [...REPOS] }),
        changes: () => gitChanges(),
        fileDiff: ({ repo, path }) => fileDiff(repo, path),
        branches: () => ({ branches: [{ name: `main`, current: true, ahead: 0, behind: 0, at: STARTED_AT }], remotes: [] }),
        commit: () => refuse(`This is the demo workspace: commits need a real repository.`),
        push: () => refuse(`This is the demo workspace: there is no remote to push to.`),
        // Where each repo lives online, matched against the registry for the publish path picker.
        remoteRepos: () => ({ repos: [...REMOTE_REPOS] }),
        // Refused like commit and push: there is no remote to publish to.
        publishFile: () => PUBLISH_REFUSAL,
    },
    diff: {
        derived: () => ({ before: derivedSide(HANDOVER_TEXT_BEFORE), after: derivedSide(HANDOVER_TEXT) }),
    },
    // One connected Claude subscription; the composer's account gate needs at least one to stop waiting. The path is
    // the daemon's own `/accounts/{provider}` (provider-module.ts). It used to be `/{provider}/accounts` here, and
    // when the app moved, every read 404'd: `accountsLoaded` never flipped, so the Agent tab drew skeleton rows for as
    // long as you left it open — including in the marketing shots.
    accounts: {
        accounts: ({ provider }) => ({ accounts: provider === `claude` ? [DEMO_CLAUDE_ACCOUNT, DEMO_CLAUDE_ACCOUNT_SECOND] : [] }),
    },
    translator: {
        // Codex authenticates only through the translator, not an oauth account.
        accounts: () => DEMO_TRANSLATOR_ACCOUNTS,
        // Starts a routed sign-in so ConnectFlow is reachable here: without it the panel a new user meets first
        // could only be seen against a real daemon. `redirect` is the shape Google uses (a loopback dead-end).
        connect: ({ provider }) => ({ url: `https://accounts.google.com/o/oauth2/auth?demo=${provider}`, code: ``, state: DEMO_CONNECT_STATE, flow: `redirect` }),
        // Never resolves: the demo has no browser trip to complete, and "waiting" is the state worth being able to look at.
        status: () => ({ status: `wait` }),
        complete: () => ({ ok: true }),
    },
    providers: {
        // An unconnected provider answers empty, matching the real daemon's behavior.
        models: ({ provider }) => DEMO_CATALOGS[provider] ?? { models: [], default: `` },
        // The recorded workspace adds no ACP agent and no endpoint of its own, but the composer's gate waits on this read
        // as much as on the accounts above it.
        // The recording is a box with Claude connected, which is what its chats are addressed to; `native` is how a
        // reader who cannot open /accounts learns that.
        list: () => ({ native: [`claude`], agents: [], endpoints: [] }),
    },
    endpoints: {
        // What the connect view's local lane draws: a 32 GB laptop with no GPU passed through and nothing downloaded yet.
        localModelFit: () => demoLocalModelFit(),
        // Nothing is really fetched here; the press flips the fixture so the lane draws the state it has the most to say
        // about — a transfer under way, with the Stop that declines it.
        localModelPrefetch: ({ action }) => demoStartPrefetch(action === `start`),
    },
    settings: {
        get: () => DEMO_SETTINGS,
        savings: () => DEMO_SAVINGS,
        // A brief that exists, is maintained, and does not entirely fit the budget: the state the row has the most to say
        // about, and the only one where "ranks 1-5 of 12" means anything.
        fieldNotes: () => ({
            present: true,
            writtenAt: STARTED_AT - 19 * 24 * 60 * 60_000,
            ranksSent: 5,
            ranksTotal: 12,
            chars: 2_784,
            automation: `enabled`,
            nextRunAt: STARTED_AT + 11 * 24 * 60 * 60_000,
        }),
        // No rule has ever fired in a recorded demo; an empty table is the honest answer.
        firings: () => ({}),
        // What the two repositories in this workspace declare for themselves, in the three states the group has to be
        // able to show: running, waiting on the owner, and held because the file changed under an adoption.
        repoChecks: () => DEMO_REPO_CHECKS,
        adoptRepoChecks: () => refuse(`This is the demo workspace: there is no repository here to run a check on.`),
    },
    // Long enough to overflow its section, because that is the only state the policy's surface has a decision to make
    // in: without it the demo drew "Loading…" here forever and the section could not be looked at at all.
    safety: {
        policy: () => ({ text: DEMO_SAFETY_POLICY, custom: false }),
    },
    vpn: {
        list: () => ({ links: [] }),
    },
    // CI board data is real; the badge reflects the fixture's own state. Rerun, cancel and Fix-with-agent
    // refuse: a recording can't act on a real pipeline.
    ci: {
        runs: () => ciRunsResponse(Date.now()),
        jobs: ({ repo, runId }) => ({ jobs: ciJobs(repo, runId, Date.now()) }),
        rerun: () => refuse(`This is the demo workspace: rerunning would start a pipeline on a repo that isn't yours.`),
        cancel: () => refuse(`This is the demo workspace: there is no live pipeline to cancel.`),
        fix: () => refuse(`This is the demo workspace: a fix agent needs your repo and its CI logs. Start a sandbox and this button opens one.`),
    },
    // GET /chores computes rows in the browser from fixture/chores.ts; the ledger is real state. Re-running
    // a probe refuses: it needs a subprocess this recording lacks.
    chores: {
        list: () => choresReport(Date.now()),
        record: (entry) => okAfter(() => writeLedger(Date.now(), entry)),
        probe: () => refuse(`This is the demo workspace: a probe runs pnpm audit or knip against a real checkout.`),
    },
    // Enabling, editing, deleting and clearing a held wake are real (the fixture is the store); firing one
    // refuses, since a wake is a real agent turn.
    automations: {
        list: () => ({ automations: automationsList(Date.now()) }),
        // What can wake an agent and what it can start from, for the composer's source picker.
        catalog: () => automationCatalog(),
        pendingList: () => ({ approvals: automationApprovals(Date.now()) }),
        upsert: (automation) => okAfter(() => saveAutomation(Date.now(), automation)),
        remove: ({ id }) => okAfter(() => deleteAutomation(Date.now(), id)),
        run: () => refuse(`This is the demo workspace: firing an automation runs a real turn against real systems.`),
        approve: () => refuse(`This is the demo workspace: approving a held wake would start the turn it is holding.`),
        reject: ({ id }) => okAfter(() => resolveApproval(Date.now(), id)),
    },
    // Reading is real; running one refuses, since a run is several real agent sessions. Saving/deleting also
    // refuse: a kept design must not vanish on reload.
    workflows: {
        list: () => ({ workflows: demoWorkflows(runsOnBoard(Date.now())) }),
        runs: () => ({ runs: runsOnBoard(Date.now()) }),
        save: () => refuse(`This is the demo workspace: designs are read-only here.`),
        remove: () => refuse(`This is the demo workspace: designs are read-only here.`),
        run: () => refuse(`This is the demo workspace: running a workflow starts several agent sessions on a real tree.`),
        stopRun: () => refuse(`This is the demo workspace: nothing is really running to stop.`),
        // Archiving is one-way here with no way back, so it refuses instead of losing sessions silently.
        archiveRun: () => refuse(`This is the demo workspace: the archive here has no way back, so a run stays on the board.`),
        unarchiveRun: () => refuse(`This is the demo workspace: nothing has been archived to restore.`),
    },
    // Reading is real, showing two ways a message can rerun. Saving/deleting refuse, like every design here:
    // a kept one would vanish on reload.
    loops: {
        designs: () => ({ designs: demoLoops() }),
        saveDesign: () => refuse(`This is the demo workspace: saved loops are read-only here.`),
        removeDesign: () => refuse(`This is the demo workspace: saved loops are read-only here.`),
    },
    capabilities: {
        list: () => ({ capabilities: demoCapabilities() }),
        // Every registry URL answers the same joined data; the real route would clone a repo and read two JSON
        // files from it.
        marketplace: () => demoRegistry(),
    },
    // The persona picker's data; three personas make the point without turning the column into a directory. A save
    // is real (the fixture is the store), so the project persona New agent makes under a scope shows in the picker.
    personas: {
        list: () => ({ personas: demoPersonas, connected: [`gmail-support`, `intercom`, `x-brand`, `linkedin`, `github`, `stripe-ops`] }),
        save: (card) => okAfter(() => savePersona(card)),
    },
    // The named parts of the workspace a grant can be fenced to; a save is real, like a persona's, so the Areas
    // page edits what the Access tab's picker then offers.
    areas: {
        list: () => ({ areas: demoAreas }),
        save: (area) => okAfter(() => saveArea(area)),
        remove: ({ id }) => okAfter(() => removeArea(id)),
    },
    usage: {
        rollup: () => ({ rows: demoUsageRollup(STARTED_AT) }),
        // What every connection read posts, on arrival and on the rail's refresh control alike. Nothing held: every demo
        // reading is taken, so the press moves the age rather than explaining why it couldn't.
        refreshPlanLimits: () => ({ ok: true, held: [] }),
    },
    secrets: {
        inventory: () => ({ entries: [] }),
    },
    ports: {
        list: () => ({ ports: [] }),
    },
    // Facts each extension's detect() runs over, for which tiles the rail carries; starting a dev server refuses.
    panels: {
        list: () => ({ panels: demoPanels() }),
        start: () => refuse(`This is the demo workspace: a dev server needs the repository on your own machine.`),
        stop: () => refuse(`This is the demo workspace: nothing is running to stop.`),
    },
    extensions: {
        // `invalid` and `pending` are required by the contract; omitting either fails the whole list to parse.
        list: () => ({ extensions: demoExtensions(), invalid: [], pending: [] }),
        setEnabled: ({ id, enabled }) => okAfter(() => setExtensionEnabled(id, enabled)),
        // Loaded before an extension's activate(), so `api.settings.get` is synchronous; missing here means the
        // extension never activates.
        settings: () => ({ settings: {}, secretsSet: [] }),
        setSettings: () => ({ ok: true }),
    },
    approvals: {
        list: () => ({ approvals: [], invalid: [] }),
        // The demo's Claude settings declare no hooks, so no turn ever held one for approval.
        hookRequests: () => ({ requests: [] }),
    },
} satisfies FixtureRouter;

// The document's bytes, as a viewer parses them: a picture of text would not do.
const documentBytes = (bytes: Uint8Array<ArrayBuffer>): Response =>
    new Response(bytes, { status: 200, headers: { "content-type": `application/vnd.openxmlformats-officedocument.wordprocessingml.document` } });

// Report screenshots (svg keeps them a few kilobytes and sharp at any size) and the one document, which is the only
// path here whose bytes are bytes: a viewer parses it, so text would not do.
const workspaceRaw = (path: string): Response => {
    if (path === SUPPLIER_LETTER_PATH) {
        return documentBytes(SUPPLIER_LETTER_DOCX);
    }
    if (path === HANDOVER_PATH || path === HANDOVER_CHANGE_PATH) {
        return documentBytes(HANDOVER_DOCX);
    }
    const body = fileBody(path) ?? refuse(`No such file: ${path}`, 404);
    return new Response(body, { status: 200, headers: { "content-type": path.endsWith(`.svg`) ? `image/svg+xml` : `text/plain; charset=utf-8` } });
};

// Every picture in this fixture is already small, so a tile is the file itself; only SVG is refused, as the daemon does.
const workspaceThumb = (path: string): Response => (path.endsWith(`.svg`) ? refuse(`not a picture this can draw`, 415) : workspaceRaw(path));

// The refusals the real daemon makes on the spot (auth/members/members.routes.ts): a writer and a maker each need a
// fence, since for both the areas are the tier rather than a narrowing of it, and a maintainer cannot carry one at
// all, since it holds the owner's operating authority and a folder fence over it would enforce nothing.
const grantMember = async ({ request }: RawContext): Promise<Response> => {
    const grant = (await request.json()) as DemoGrant;
    if ((grant.areas?.length ?? 0) === 0 && (grant.role === `writer` || grant.role === `guest`)) {
        return refuse(`a ${grant.role} needs at least one area`, 400);
    }
    if (grant.role === `maintainer` && grant.areas !== undefined) {
        return refuse(`a maintainer holds the owner's operating authority and cannot be fenced to part of the workspace`, 400);
    }
    grantAccess(grant.email, grant.role, grant.areas);
    return json({ members: grants() });
};

const revokeMember = async ({ request }: RawContext): Promise<Response> => {
    revokeAccess(((await request.json()) as { email: string }).email);
    return json({ members: grants() });
};

// Served under the extension's own namespace and paths, so a boundary move is a compile error, not an empty panel.
// Answers come from the extension's real engine over fixture/knowledge.ts.
const knowledge: Readonly<Record<string, (context: RawContext) => Response | Promise<Response>>> = {
    [`GET ${KNOWLEDGE_BASE}/overview`]: () => json(knowledgeOverview()),
    [`GET ${KNOWLEDGE_BASE}/notes`]: () => json({ notes: knowledgeNotes() }),
    [`GET ${KNOWLEDGE_BASE}/search`]: ({ url }) => json({ hits: knowledgeSearch(url.searchParams) }),
    [`GET ${KNOWLEDGE_BASE}/note`]: ({ url }) => json(knowledgeNoteAt(url.searchParams.get(`path`) ?? ``) ?? refuse(`No such note.`, 404)),
    [`GET ${KNOWLEDGE_BASE}/graph`]: ({ url }) => json(knowledgeGraph(url.searchParams)),
    // Refuses exactly what the real backend refuses: a path outside the knowledge folder, or not a note.
    [`PUT ${KNOWLEDGE_BASE}/note`]: async ({ request }) => {
        const { path, content } = (await request.json()) as { path?: string; content?: string };
        return saveKnowledgeNote(Date.now(), path ?? ``, content ?? ``)
            ? json({ ok: true })
            : refuse(`That is not a markdown note inside the knowledge folder.`, 400);
    },
    [`DELETE ${KNOWLEDGE_BASE}/note`]: async ({ request }) => {
        const path = ((await request.json()) as { path?: string }).path ?? ``;
        return deleteKnowledgeNote(Date.now(), path) ? json({ ok: true }) : refuse(`No such note.`, 404);
    },
    // The demo knowledge base already started, so this only ever answers nothing to write.
    [`POST ${KNOWLEDGE_BASE}/seed`]: () => json({ written: [] }),
};

// The routes the daemon serves outside oRPC that the app reaches here, keyed as the contract declares them.
const raw: RawRoutes = {
    // No loopback shortcut here; the demo daemon is only ever at its own origin.
    "GET /health": () => json({ error: `The demo has no local daemon to shortcut to.` }, 404),
    // A WebSocket can't carry a bearer header, so this ticket stands in for one per upgrade.
    "POST /system/ws-ticket": () => json({ ticket: `demo-ticket` }),
    // Screenshot bytes for an <img>, served here rather than from /public.
    "GET /workspace/raw": ({ url }) => workspaceRaw(url.searchParams.get(`path`) ?? ``),
    // A picture at tile size, answered as the daemon answers it: SVG is refused (415) for the client to draw the file.
    "GET /workspace/thumb": ({ url }) => workspaceThumb(url.searchParams.get(`path`) ?? ``),
    // Pre-flight for the upload queue; nothing here is ever a re-drop, so it always reports none to skip.
    "POST /workspace/upload-diff": () => json({ skip: [] }),
    "POST /workspace/upload": async ({ request, url }) => {
        const body = await request.text();
        return json(okAfter(() => writeFile(url.searchParams.get(`path`) ?? ``, body)));
    },
    // The one binary diff the demo carries whole: the handover document, both versions built in code.
    "GET /diff/raw": ({ url }) => documentBytes(url.searchParams.get(`which`) === `before` ? HANDOVER_DOCX_BEFORE : HANDOVER_DOCX),
    // The listed extensions' bundles, served as a daemon serves an installed checkout's `entry`; the loader blob-imports
    // them, so the demo runs the published bytes rather than a compiled-in copy.
    "GET /extensions/{id}/bundle": ({ param }) => vendoredBundle(param(`id`)),
    // The enforced roster, mutable: the Access tab pushes its grant here first, and a maker's chips come back from it.
    "GET /members": () => json({ members: grants() }),
    "POST /members": grantMember,
    "DELETE /members": revokeMember,
    // Two tokens on the roster (one unused, one expiring) make the roster's states visible; a mint answers
    // the once-shown value.
    "GET /system/control/tokens": () =>
        json({
            tokens: [
                {
                    id: `ct_ci`,
                    label: `nightly CI`,
                    scope: `drive`,
                    createdAt: Date.now() - 12 * 24 * 3_600_000,
                    createdBy: `ada@acme.dev`,
                    expiresAt: Date.now() + 78 * 24 * 3_600_000,
                    lastUsedAt: Date.now() - 6 * 3_600_000,
                },
                { id: `ct_zed`, label: `Zed on laptop`, scope: `editor`, createdAt: Date.now() - 40 * 24 * 3_600_000, createdBy: `ada@acme.dev` },
            ],
        }),
    "POST /system/control/tokens": () => json({ id: `ct_new`, token: `***` }),
    "DELETE /system/control/tokens/{id}": () => json({ ok: true }),
    "GET /environment": () => json(demoEnvironment()),
    "GET /environment/contents": () => json(demoEnvironmentContents()),
    // Read on first render; a published workspace and empty exports/computers are the tab's default states
    // before the visitor clicks anything.
    "GET /definition/workspace": () => json({ remote: `https://github.com/acme/intentic-sandbox-ada.git`, branch: `main`, hosts: [`github.com`] }),
    "GET /bundles": () => json({ exports: [] }),
    "GET /arrivals/hosts": () => json({ hosts: [] }),
    // The checklist an upload produces: one row per repo, one for workspace files, one for history, plus two
    // steps the arrival can't do for the owner.
    "POST /arrivals/plan": () =>
        json({
            source: `bundle`,
            token: `demo-arrival`,
            name: `acme-shop`,
            carriesSecrets: true,
            items: [
                {
                    id: `bundle:files`,
                    group: `files`,
                    label: `Workspace files`,
                    detail: `Everything in /work that is not one of the repositories below, and the workspace repo's own history — 4,213 files, 41.8 MB`,
                    applicable: true,
                    recommended: true,
                    secrets: [`STRIPE_SECRET_KEY`],
                },
                {
                    id: `repo:acme-shop`,
                    group: `repo`,
                    label: `Repository acme-shop`,
                    detail: `Its working tree and its full git history — 1,904 files, 12.2 MB`,
                    applicable: true,
                    recommended: true,
                    secrets: [],
                },
                {
                    id: `repo:design-system`,
                    group: `repo`,
                    label: `Repository design-system`,
                    detail: `Its working tree and its full git history — 22,610 files, 6.1 GB`,
                    applicable: true,
                    recommended: true,
                    secrets: [],
                },
                {
                    id: `bundle:history`,
                    group: `history`,
                    label: `Sandbox history`,
                    detail: `Transcripts, checkpoint timelines and ledgers, the part nothing else can reproduce — 8,802 files, 310.4 MB`,
                    applicable: true,
                    recommended: true,
                    secrets: [],
                },
            ],
            refused: [`history/session-secret (this sandbox does not accept identity files)`],
            needsAction: [
                {
                    subject: `Rebuild the environment image`,
                    detail: `The overlay Dockerfile travels, but the IMAGE it describes is built outside the container. Open the Environment card and run the rebuild command it shows.`,
                },
                {
                    subject: `Reconnect capabilities`,
                    detail: `Each connection arrives listed but unauthenticated. Open these on the Capabilities view and re-enter the credential each one asks for: github (git), linear (mcp).`,
                },
            ],
        }),
    // An extension backend's namespace: only the knowledge extension's is fixtured.
    "ALL /x/*": (context) => knowledge[`${context.request.method} ${context.url.pathname}`]?.(context),
};

const DEMO_COMMANDS = [
    { name: `plan`, description: `Think a change through before touching anything` },
    { name: `review`, description: `Review the working diff` },
    { name: `test`, description: `Run the affected tests`, hint: `[path]` },
];

const DEMO_CLAUDE_ACCOUNT: OauthAccount = {
    id: `acc_claude_demo`,
    label: `Claude Max`,
    email: `ada@acme.dev`,
    organization: `Acme`,
    connectedAt: STARTED_AT - 30 * 24 * 3_600_000,
};

const DEMO_CLAUDE_ACCOUNT_SECOND: OauthAccount = {
    id: `acc_claude_demo_2`,
    label: `Claude Pro`,
    email: `work@acme.dev`,
    organization: `Acme`,
    connectedAt: STARTED_AT - 12 * 24 * 3_600_000,
};

const DEMO_TRANSLATOR_ACCOUNTS: TranslatorAccounts = {
    codex: [{ name: `chatgpt-ada`, label: `ChatGPT Pro · ada@acme.dev` }],
    grok: [],
    kimi: [],
    gemini: [],
};

const CLAUDE_MODELS: Model[] = [
    { id: `claude-opus-5`, label: `Claude Opus 5`, efforts: [`low`, `medium`, `high`, `max`], badges: [`reasoning`] },
    { id: `claude-sonnet-5`, label: `Claude Sonnet 5`, efforts: [`low`, `medium`, `high`] },
    { id: `claude-haiku-4-5-20251001`, label: `Claude Haiku 4.5`, badges: [`fast`] },
];

// One model cooling: every credential the translator holds is refused for it until then. Relative to load, since an
// absolute instant in a fixture is a state that reads as expired by the next time anyone opens this.
const CODEX_MODELS: Model[] = [
    { id: `gpt-5.2-codex`, label: `GPT-5.2 Codex`, efforts: [`low`, `medium`, `high`], badges: [`reasoning`] },
    { id: `gpt-5.2`, label: `GPT-5.2`, efforts: [`low`, `medium`, `high`], availableAt: Math.floor(Date.now() / 1000) + 45 * 60 },
];

// Google's routed lane serves other makers' models, so its catalog is mixed rather than Gemini-only.
const GEMINI_MODELS: Model[] = [
    { id: `claude-opus-4-6`, label: `Claude Opus 4.6 (Thinking)`, efforts: [`low`, `medium`, `high`], badges: [`reasoning`] },
    { id: `gemini-3-1-pro`, label: `Gemini 3.1 Pro`, efforts: [`low`, `medium`, `high`], badges: [`reasoning`] },
    { id: `gemini-3-5-flash`, label: `Gemini 3.5 Flash`, efforts: [`low`, `medium`, `high`], badges: [`fast`] },
    { id: `gpt-oss-120b`, label: `GPT-OSS 120B`, efforts: [`low`, `medium`, `high`] },
];

// Claude and Codex are connected; Google is listed while still locked, which is what a new user meets first
// and the only state where the picker's whole locked band is on screen.
const DEMO_CATALOGS: Readonly<Record<string, { models: Model[]; default: string }>> = {
    claude: { models: CLAUDE_MODELS, default: `claude-sonnet-5` },
    codex: { models: CODEX_MODELS, default: `gpt-5.2-codex` },
    gemini: { models: GEMINI_MODELS, default: `gemini-3-1-pro` },
};

// An empty rule table puts a finished agent in Ready to land, with nothing else deciding otherwise. One role is
// pinned to a provider with no credential here: a pin is written, not resolved, so "not connected" is a state the
// settings page has to be able to draw, and the only way to see it is to have one.
const DEMO_SETTINGS: SandboxHandlerOutput<`settings`, `get`> = {
    rules: [],
    systemPromptMode: `intentic`,
    stableSystemPrompt: true,
    skills: [],
    modelRoles: { "commit-message": [{ provider: `gemini`, model: `gemini-3-1-pro` }] },
    // The two measured mechanisms are on with a holdout running, since their readout is the only place the
    // measurement block is drawn and an off switch hides it entirely.
    iqSearch: true,
    iqSearchHoldout: 0.1,
    workspaceMap: true,
    workspaceMapHoldout: 0.1,
    fieldNotes: true,
    fieldNotesBudget: 4000,
    fieldNotesHoldout: 0.2,
    leanGuidance: true,
    leanGuidanceHoldout: 0.2,
    sidecars: true,
};

// What a conversation was told before its first word. Every source at once, because the chip's whole job is to let a
// reader tell an arriving AGENTS.md from a dropped one, and a fixture with three of the four could not show that.
const DEMO_SYSTEM_PROMPT: ConversationPrompt = {
    prompt: {
        at: STARTED_AT - 6 * 60_000,
        runtime: `claude-code`,
        mode: `intentic`,
        base: {
            kind: `intentic`,
            text: "You are an Intentic agent.\n\nYou work in one sandbox, on one workspace, for one person, and you finish what you are asked rather than reporting on how far you got.",
        },
        sections: [
            {
                source: `guidance`,
                title: `Working in this sandbox`,
                text: "## Working in this sandbox\n\nYou run inside Intentic, a sandbox serving one workspace from a browser editor. For anything about Intentic itself, load the `intentic` skill before answering.\n\nSearch code with `rg`, never `grep -r`, which walks node_modules.\n\nThe owner lands uncommitted work; commit only when asked.",
            },
            {
                source: `persona`,
                title: `Who this turn is acting as`,
                text: "## Who this turn is acting as\n\nYou are acting as **Studio**, which may read and write files and run commands, and reaches the `github` account alone.",
            },
            {
                source: `field-notes`,
                title: `Field notes for this sandbox`,
                text:
                    `## Field notes for this sandbox\n\nWritten 19 days ago from this sandbox's own record; ranks 1-5 of 12 are below.\n\n` +
                    `### Which tree you are standing in\n\n\`${WORKSPACE_ROOT}\` is the shared checkout every other agent is editing; your branch ` +
                    `is the worktree you were started in.\n\n### Toolchain\n\n\`pnpm\`'s exit code lies after a successful build here: ` +
                    `\`node_modules\` is an overlay mount and the hardlink sync fails across the device boundary. Read the build's own output, not the code.`,
            },
            {
                source: `memory`,
                title: `Standing instructions for this workspace`,
                text: "## Standing instructions for this workspace\n\n### AGENTS.md\n\n- No legacy support – make clean breaking changes; update all usages.\n- No migration logic – assume fresh state; remove compatibility layers.",
            },
        ],
    },
};

/* The checks each repository declares for itself (`<repo>/.intentic/checks.json`), one repository per state the group can be in: `web` running. */
const DEMO_REPO_CHECKS: RepoChecksList = {
    repos: [
        {
            repo: `web`,
            path: `web/${REPO_CHECKS_FILE}`,
            checks: [
                { when: `turn`, run: `pnpm -C web lint` },
                { when: `push`, run: `pnpm -C web test` },
            ],
            adopted: true,
            changed: false,
        },
        { repo: `api`, path: `api/${REPO_CHECKS_FILE}`, checks: [{ when: `push`, run: `pnpm -C api test` }], adopted: false, changed: false },
        {
            repo: `root`,
            path: REPO_CHECKS_FILE,
            checks: [{ when: `push`, run: `./scripts/release-guard.sh --strict` }],
            adopted: false,
            changed: true,
        },
    ],
};

const DEMO_SAFETY_POLICY = [
    `# Safety policy`,
    `How you should decide whether to stop and ask me before running something. You are judging one command at a time, and most of what reaches you is ordinary work a pattern match flagged by accident — a command that merely mentions a dangerous verb, a script being written to a file, a search whose pattern happens to look like a deletion. Allow those.`,
    `## In this sandbox`,
    `Everything under /work is a git worktree and everything in this container is disposable, so building, testing, editing, committing and deleting build output are all ordinary. Don't ask about them, however alarming the command looks in isolation.`,
    `Ask me before:`,
    `- publishing or releasing anything (npm publish, a GitHub release, a container push);\n- force-pushing or discarding commits that are not this turn's own work;\n- sending a credential anywhere outside this container.`,
    `## On my computers`,
    `A connected computer is not disposable and its files are not in any worktree. Ask before deleting anything there, before installing system packages, and before anything that touches a running service.`,
].join(`\n\n`);

// What the tool-output cleaners saved over the shown window, reported per-stage like the real product.
const DEMO_SAVINGS: SavingsReport = {
    input: {
        updatedAt: STARTED_AT - 4 * 60_000,
        commands: 218,
        rawTokens: 1_284_600,
        emittedTokens: 402_140,
        savedPct: 68.7,
        perCleaner: [
            { id: `cap`, commands: 96, savedTokens: 553_700 },
            { id: `failtail`, commands: 41, savedTokens: 191_200 },
            { id: `cache`, commands: 81, savedTokens: 137_560 },
        ],
        holdout: { cleaned: 196, heldOut: 22, measuredSavedPct: 66.4 },
        gaps: [
            { command: `pnpm -C web build`, commands: 14, tokens: 41_200 },
            { command: `docker compose logs api`, commands: 6, tokens: 28_900 },
        ],
    },
    // The search teaching, in the state most of the block's surface has to draw: both arms past the threshold, the
    // margin measured, the effect still inside it. The second metric is the same subject read a second way.
    search: {
        minTurns: 60,
        sampleUnit: `conversations`,
        metrics: [
            { metric: `searchCalls`, on: { turns: 356, mean: 2.4 }, off: { turns: 111, mean: 2.6 }, marginPct: 19.5, controlTurnsNeeded: 312 },
            { metric: `openingSearches`, on: { turns: 356, mean: 1.1 }, off: { turns: 111, mean: 1.2 }, marginPct: 24.1 },
        ],
    },
    // The map has resolved on its headline and not on its second reading, so both verdict states are on screen at once.
    map: {
        minTurns: 60,
        sampleUnit: `conversations`,
        metrics: [
            {
                metric: `openingListings`,
                on: { turns: 355, mean: 0.6 },
                off: { turns: 100, mean: 1.7 },
                marginPct: 29.6,
                deltaPct: -63.7,
                saved: 388,
            },
            { metric: `callsBeforeTarget`, on: { turns: 355, mean: 5.2 }, off: { turns: 100, mean: 5.4 }, marginPct: 17.8, controlTurnsNeeded: 640 },
        ],
    },
    // The field notes in their third state, the one neither block above shows: not enough control conversations yet, so
    // both arms are reported and no claim is made. `cohort` is the revision in play, which is what a monthly rewrite
    // moves.
    notes: {
        minTurns: 30,
        sampleUnit: `conversations`,
        cohort: `a41f9c2e`,
        metrics: [
            { metric: `failedCalls`, on: { turns: 84, mean: 1.3 }, off: { turns: 21, mean: 2.1 } },
            { metric: `callsBeforeTarget`, on: { turns: 84, mean: 4.9 }, off: { turns: 21, mean: 5.1 } },
        ],
    },
};

export const daemon = serve(procedures, raw);

/** How much of the real daemon this fixture stands in for, reported once at boot, so the gap is visible. */
export const coverage = (): { served: number; contract: number } => coverageOf(procedures);
