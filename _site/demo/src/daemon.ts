import {
    type AgentSearchResult,
    type AgentsList,
    type AgentSummary,
    AgentReplySchema,
    type Automation,
    type BrowsersList,
    ChoreLedgerWriteSchema,
    type CiJobsResponse,
    type DevicesList,
    type Info,
    type Persona,
    type Model,
    type OauthAccount,
    type OauthAccountList,
    type PresenceUser,
    REPO_CHECKS_FILE,
    type RepoChecksList,
    SANDBOX_ROUTE_NAMES,
    type SavingsReport,
    type SubagentsList,
    type SystemEvent,
    type TerminalsList,
    type TranslatorAccounts,
    type WorkflowRun,
} from "@intentic/sandbox-contract";
import { KNOWLEDGE_BASE } from "../vendor/knowledge/wire-types";
import { BROWSER_SESSIONS } from "./browser";
import { automationApprovals, automationCatalog, automationsList, deleteAutomation, resolveApproval, saveAutomation } from "./fixture/automations";
import { demoDevices } from "./fixture/devices";
import { demoLoops } from "./fixture/loops";
import { demoRuns, demoWorkflows } from "./fixture/workflows";
import { choresReport, writeLedger } from "./fixture/chores";
import { ciJobs, ciRunsResponse } from "./fixture/ci";
import { DESK_AWAITING_ID, DESK_FEATURED_ID, DESK_SANDBOX_NAME, deskRoster, SUPPLIER_LETTER_DOCX, SUPPLIER_LETTER_PATH } from "./fixture/desk";
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
import { demoMode, deskEdition } from "./mode";
import { eventStream } from "./sse";
import { featuredRun, type Run, visitorRun } from "./turn";
import { json, refuse } from "./transport";

// A fetch handler standing in for the real daemon in the browser tab. Routes are typed against the
// contract, so a shape drift is a build error, not a silent gap. Not an oRPC server: no runtime payload
// validation here.

const STARTED_AT = Date.now();

// Which recording's two special cards this page serves: the run with a script behind it, and the one parked on a question.
const FEATURED_ID = deskEdition ? DESK_FEATURED_ID : FEATURED_AGENT_ID;
const AWAITING_ID = deskEdition ? DESK_AWAITING_ID : AWAITING_AGENT_ID;

// Live state; every write bumps `rev` and re-broadcasts (snapshot-not-diff, newest rev wins).
const roster = {
    agents: deskEdition ? deskRoster(STARTED_AT) : fleetRoster(STARTED_AT).filter((agent) => demoMode.agents?.includes(agent.id) ?? true),
    rev: 1,
};

// Held automation approvals project onto the board's attention lane; a desk runs no automations.
const heldApprovals = () => (deskEdition ? [] : automationApprovals(Date.now()));
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

const events = (request: Request): Response =>
    eventStream(request, (sink) => {
        const listener = (event: SystemEvent): void => sink.emit(event);
        listeners.add(listener);

        sink.emit({ kind: `hello`, workspaceId: `demo-workspace`, build: `demo`, boot: { ready: true, startedAt: STARTED_AT, steps: [] } });
        sink.emit({ kind: `agents`, agents: roster.agents, rev: roster.rev });
        sink.emit({ kind: `reposChanged`, repos: [...REPOS] });
        sink.emit({ kind: `presence`, users: demoMode.teammate ? [OWNER, TEAMMATE] : [OWNER] });

        const beat = setInterval(() => sink.emit({ kind: `heartbeat` }), HEARTBEAT_MS);
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

const attach = async (request: Request): Promise<Response> => {
    const body = (await request.json()) as { conversationId?: string };
    const conversationId = body.conversationId;
    if (conversationId === undefined) {
        return refuse(`A conversation id is required.`, 400);
    }
    const run = runFor(conversationId);
    if (run === undefined) {
        // Nothing is running on this conversation, the same empty stream a real daemon answers with.
        return eventStream(request, (sink) => {
            sink.emit({ kind: `end` });
            sink.close();
            return () => {};
        });
    }
    return eventStream(request, (sink) => {
        run.attach(sink);
        return () => {};
    });
};

// One device agent's update or restart, in the frames the real flow sends: `line` for progress, `result` for what the
// machine says at the end. Paced so a press is watchable rather than over before the row has drawn its log.
const AGENT_STEP_MS = 450;
const agentFlow = (request: Request, id: string, op: string): Response => {
    const said =
        op === `restart`
            ? { lines: [`Stopping the agent loop on ${id}.`], result: `The agent loop was restarted on this device.` }
            : {
                  lines: [`Downloading the current agent (1.275.0)…`, `  100% of 87 MB`, `Swapping the binary and restarting the loop.`],
                  result: `Already on the current agent (1.275.0). Nothing to do.`,
              };
    return eventStream(request, (sink) => {
        let step = 0;
        const timer = setInterval(() => {
            if (step < said.lines.length) {
                sink.emit({ kind: `line`, text: said.lines[step] });
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

const startTurn = async (request: Request): Promise<Response> => {
    const body = (await request.json()) as { conversationId?: string; prompt?: string };
    const conversationId = body.conversationId ?? FEATURED_ID;
    if (EXTENSION_RUN_PREFIXES.some((prefix) => conversationId.startsWith(prefix))) {
        return refuse(`This is the demo workspace: a run needs your repositories and a sandbox to walk them in. Start one and this button works.`);
    }
    runs.get(conversationId)?.stop();
    const run = visitorRun(conversationId, body.prompt ?? ``, Date.now());
    runs.set(conversationId, run);
    patchAgent(conversationId, { status: `running`, startedAt: Date.now(), updatedAt: Date.now() });
    return json({ run: run.id });
};

const reply = async (request: Request): Promise<Response> => {
    const parsed = AgentReplySchema.safeParse(await request.json());
    if (!parsed.success) {
        return refuse(`That reply isn't in a shape the daemon accepts.`, 400);
    }
    for (const run of runs.values()) {
        run.resolve(parsed.data.requestId, parsed.data);
    }
    // The card that was parked belongs to the agent whose attention flag raised it: answering clears it.
    patchAgent(AWAITING_ID, {
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    return json({ ok: true });
};

// Moves the agent's delta into the main tree on success (fixture/workspace.ts) and broadcasts
// `workspaceChanged`; on failure, flips the card to conflict with the check's report.
const land = (id: string): Response => {
    const result = landAgentDelta(id);
    if (!result.landed) {
        patchAgent(id, {
            status: `conflict`,
            updatedAt: Date.now(),
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: true },
        });
        return json(result);
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
    return json(result);
};

const info: Info = { name: deskEdition ? DESK_SANDBOX_NAME : `acme-shop`, version: `demo`, latest: `demo`, updateAvailable: false };

// The handshake `state` a routed sign-in issues; ConnectFlow only accepts a pasted address carrying this one.
const DEMO_CONNECT_STATE = `demo-connect-state`;

// Route table: ordered, first match wins; `{name}` matches one path segment, read back via `param`. An
// empty-but-real area answers its contract's empty shape, not a 404.
interface RouteContext {
    readonly request: Request;
    readonly url: URL;
    /** One `{name}` segment of the matched pattern, or "" when the pattern has no such segment. */
    readonly param: (name: string) => string;
}

type Handler = (context: RouteContext) => Response | Promise<Response>;

const ROUTES: readonly (readonly [string, string, Handler])[] = [
    [`GET`, `/events`, ({ request }) => events(request)],
    [`GET`, `/info`, () => json(info)],
    // No loopback shortcut here; the demo daemon is only ever at its own origin.
    [`GET`, `/health`, () => json({ error: `The demo has no local daemon to shortcut to.` }, 404)],
    [`POST`, `/system/session`, () => json({ token: `demo-session`, expiresAt: Date.now() + 30 * 24 * 3_600_000, email: `ada@acme.dev` })],
    [`POST`, `/system/presence`, () => json({ ok: true })],
    // A WebSocket can't carry a bearer header, so this ticket stands in for one per upgrade.
    [`POST`, `/system/ws-ticket`, () => json({ ticket: `demo-ticket` })],
    [`GET`, `/system/usage`, () => json({ accounts: [] })],
    [
        `GET`,
        `/system/terminals`,
        () =>
            json({
                sessions: [{ name: `agent-checkout-stripe`, label: `checkout-stripe`, kind: `agent`, running: true, activityAt: Date.now() }],
            } satisfies TerminalsList),
    ],
    // One still-driven browser session and one already closed, rendered as history, not a broken stream.
    [`GET`, `/system/browsers`, () => json({ sessions: BROWSER_SESSIONS(Date.now()) } satisfies BrowsersList)],
    // The owner's own computers. Without this the Devices tab could only say it had nothing to show, so nothing
    // under a paired folder — the sync switches, and the two answers to a conflict — was ever drawn.
    [`GET`, `/system/devices`, () => json({ devices: demoDevices(Date.now()) } satisfies DevicesList)],
    // The agent's own two verbs, streamed as the daemon streams them: progress lines, then the machine's sentence.
    // Each environment of a PC answers for itself, which is what a machine-wide update walks through — without this
    // the only state that page could show was the refusal of a route nobody serves.
    [`POST`, `/system/devices/{id}/agent/{op}`, ({ request, param }) => agentFlow(request, decodeURIComponent(param(`id`)), param(`op`))],
    [
        `DELETE`,
        `/system/browsers/{name}`,
        () => refuse(`This is the demo workspace: the browser you are watching is a recording, so there is nothing to close.`),
    ],
    // Must be `sessions`, the field SubagentsListSchema declares; the client parses that key.
    [`GET`, `/system/subagents`, () => json({ sessions: [] } satisfies SubagentsList)],

    // `held` mirrors /automations/pending's approval queue, projected onto the board.
    [`GET`, `/agents`, () => json({ agents: roster.agents, rev: roster.rev, held: heldApprovals() } satisfies AgentsList)],
    [`GET`, `/agents/archived`, () => json({ agents: [], rev: roster.rev, held: [] } satisfies AgentsList)],
    [`GET`, `/agents/search`, ({ url }) => json(searchAgents(url.searchParams.get(`query`) ?? ``, url.searchParams.get(`caseSensitive`) === `true`))],
    [`POST`, `/agents/seen`, () => json({ agents: roster.agents, rev: roster.rev, held: heldApprovals() } satisfies AgentsList)],
    [`GET`, `/agents/{id}/diff`, ({ param }) => json(agentChanges(param(`id`)))],
    // A card that is not mid-turn reads its transcript instead of attaching.
    [`GET`, `/agents/{id}/transcript`, ({ param }) => json(transcriptFor(param(`id`)))],
    [`GET`, `/agents/{id}/{repo}/file-diff`, ({ url, param }) => json(fileDiff(param(`repo`), url.searchParams.get(`path`) ?? ``))],
    [`POST`, `/agents/{id}/rename`, renameAgent],
    [`POST`, `/agents/{id}/seen`, ({ param }) => agentResponse(patchAgent(param(`id`), { seenAt: Date.now() }))],
    [`POST`, `/agents/{id}/react`, reactToAgent],
    [`POST`, `/agents/{id}/assign`, assignAgent],
    [`POST`, `/agents/{id}/auto-land`, ({ param }) => agentResponse(patchAgent(param(`id`), {}))],
    [`POST`, `/agents/{id}/land`, ({ param }) => land(param(`id`))],
    [`POST`, `/agents/{id}/discard`, () => refuse(`This is the demo workspace: there is no worktree to discard.`)],
    [`POST`, `/agents/archive`, archiveAgents],
    [`POST`, `/agents/unarchive`, () => json({ moved: [], rev: roster.rev })],

    [`POST`, `/agent`, ({ request }) => startTurn(request)],
    [`POST`, `/agent/attach`, ({ request }) => attach(request)],
    [`POST`, `/agent/reply`, ({ request }) => reply(request)],
    [`POST`, `/agent/steer`, () => json({ ok: true })],
    [`POST`, `/agent/stop`, stopTurn],
    [`GET`, `/agent/commands`, () => json({ commands: DEMO_COMMANDS })],
    [`GET`, `/agent/refusals`, () => json({ refusals: {} })],

    [
        `GET`,
        `/sessions`,
        ({ url }) => json({ sessions: searchSessions(url.searchParams.get(`query`) ?? ``, url.searchParams.get(`caseSensitive`) === `true`) }),
    ],
    [`GET`, `/sessions/{id}`, () => json({ messages: [] })],

    // Serves the recording's filesystem like the real daemon: a tree, lazy per-directory listing, and real
    // writes that hold until the tab reloads.
    [`GET`, `/workspace/tree`, () => json(workspaceTree())],
    [`GET`, `/workspace/children`, ({ url }) => json(workspaceChildren(url.searchParams.get(`path`) ?? ``))],
    [`GET`, `/workspace/file`, ({ url }) => workspaceRead(url.searchParams.get(`path`) ?? ``)],
    // Screenshot bytes for an <img>, served here rather than from /public.
    [`GET`, `/workspace/raw`, ({ url }) => workspaceRaw(url.searchParams.get(`path`) ?? ``)],
    // Pre-flight for the upload queue; nothing here is ever a re-drop, so it always reports none to skip.
    [`POST`, `/workspace/upload-diff`, () => json({ skip: [] })],
    [`POST`, `/workspace/upload`, workspaceUpload],
    [`DELETE`, `/workspace/entry`, workspaceDelete],
    [`GET`, `/workspace/repos`, () => json({ repos: [...REPOS] })],
    [
        `GET`,
        `/workspace/search`,
        ({ url }) =>
            json(
                searchWorkspace(url.searchParams.get(`query`) ?? ``, {
                    smart: url.searchParams.get(`mode`) === `q`,
                    literal: url.searchParams.get(`literal`) === `true`,
                    word: url.searchParams.get(`word`) === `true`,
                    caseSensitive: url.searchParams.get(`caseSensitive`) === `true`,
                    include: url.searchParams.get(`include`) ?? ``,
                }),
            ),
    ],
    [`GET`, `/git/repos`, () => json({ repos: [...REPOS] })],
    [`GET`, `/git/changes`, () => json(gitChanges())],
    [`GET`, `/git/{repo}/file-diff`, ({ url, param }) => json(fileDiff(param(`repo`), url.searchParams.get(`path`) ?? ``))],
    // The one binary diff the demo carries whole: the handover document, both versions built in code.
    [`GET`, `/diff/raw`, ({ url }) => documentBytes(url.searchParams.get(`which`) === `before` ? HANDOVER_DOCX_BEFORE : HANDOVER_DOCX)],
    [`GET`, `/diff/derived`, () => json({ before: derivedSide(HANDOVER_TEXT_BEFORE), after: derivedSide(HANDOVER_TEXT) })],
    [`GET`, `/git/{repo}/branches`, ({ param }) => json({ branches: [{ name: `main`, current: true }], repo: param(`repo`) })],
    [`POST`, `/git/{repo}/commit`, () => refuse(`This is the demo workspace: commits need a real repository.`)],
    [`POST`, `/git/{repo}/push`, () => refuse(`This is the demo workspace: there is no remote to push to.`)],
    // Where each repo lives online, matched against the registry for the publish path picker.
    [`GET`, `/git/remote-repos`, () => json({ repos: REMOTE_REPOS })],
    // Refused like commit and push: there is no remote to publish to.
    [`POST`, `/git/{repo}/publish-file`, () => json(PUBLISH_REFUSAL)],

    // One connected Claude subscription; the composer's account gate needs at least one to stop waiting. The path is
    // the daemon's own `/accounts/{provider}` (provider-module.ts). It used to be `/{provider}/accounts` here, and
    // when the app moved, every read 404'd: `accountsLoaded` never flipped, so the Agent tab drew skeleton rows and
    // the chat said "Checking your AI accounts…" for as long as you left it open — including in the marketing shots.
    [
        `GET`,
        `/accounts/{provider}`,
        ({ param }) =>
            json({ accounts: param(`provider`) === `claude` ? [DEMO_CLAUDE_ACCOUNT, DEMO_CLAUDE_ACCOUNT_SECOND] : [] } satisfies OauthAccountList),
    ],
    // Codex authenticates only through the translator, not an oauth account.
    [`GET`, `/translator/accounts`, () => json(DEMO_TRANSLATOR_ACCOUNTS)],
    // Starts a routed sign-in so ConnectFlow is reachable here: without it the panel a new user meets first
    // could only be seen against a real daemon. `redirect` is the shape Google uses (a loopback dead-end).
    [
        `POST`,
        `/translator/{provider}/connect`,
        ({ param }) => json({ url: `https://accounts.google.com/o/oauth2/auth?demo=${param(`provider`)}`, code: ``, state: DEMO_CONNECT_STATE, flow: `redirect` }),
    ],
    // Never resolves: the demo has no browser trip to complete, and "waiting" is the state worth being able to look at.
    [`GET`, `/translator/{provider}/connect`, () => json({ status: `pending` })],
    [`POST`, `/translator/{provider}/complete`, () => json({ ok: true })],
    // An unconnected provider answers empty, matching the real daemon's behavior.
    [`GET`, `/providers/{provider}/models`, ({ param }) => json(DEMO_CATALOGS[param(`provider`)] ?? { models: [], default: `` })],
    // The recorded workspace adds no ACP agent and no endpoint of its own, but the composer's gate waits on this read
    // as much as on the accounts above it.
    [`GET`, `/providers`, () => json({ agents: [], endpoints: [] })],

    [`GET`, `/settings`, () => json(DEMO_SETTINGS)],
    [`GET`, `/settings/savings`, () => json(DEMO_SAVINGS)],
    // No rule has ever fired in a recorded demo; an empty table is the honest answer.
    [`GET`, `/settings/rule-firings`, () => json({})],
    // Long enough to overflow its section, because that is the only state the policy's surface has a decision to make
    // in: without it the demo drew "Loading…" here forever and the section could not be looked at at all.
    [
        `GET`,
        `/safety/policy`,
        () =>
            json({
                text: [
                    `# Safety policy`,
                    `How you should decide whether to stop and ask me before running something. You are judging one command at a time, and most of what reaches you is ordinary work a pattern match flagged by accident — a command that merely mentions a dangerous verb, a script being written to a file, a search whose pattern happens to look like a deletion. Allow those.`,
                    `## In this sandbox`,
                    `Everything under /work is a git worktree and everything in this container is disposable, so building, testing, editing, committing and deleting build output are all ordinary. Don't ask about them, however alarming the command looks in isolation.`,
                    `Ask me before:`,
                    `- publishing or releasing anything (npm publish, a GitHub release, a container push);\n- force-pushing or discarding commits that are not this turn's own work;\n- sending a credential anywhere outside this container.`,
                    `## On my computers`,
                    `A connected computer is not disposable and its files are not in any worktree. Ask before deleting anything there, before installing system packages, and before anything that touches a running service.`,
                ].join(`\n\n`),
                custom: false,
            }),
    ],
    // What the two repositories in this workspace declare for themselves, in the three states the group has to be able
    // to show: running, waiting on the owner, and held because the file changed under an adoption.
    [`GET`, `/settings/repo-checks`, () => json(DEMO_REPO_CHECKS)],
    [`POST`, `/settings/repo-checks/adopt`, () => refuse(`This is the demo workspace: there is no repository here to run a check on.`)],
    [`GET`, `/vpn`, () => json({ networks: [] })],

    // CI board data is real; the badge reflects the fixture's own state. Rerun, cancel and Fix-with-agent
    // refuse: a recording can't act on a real pipeline.
    [`GET`, `/ci/runs`, () => json(ciRunsResponse(Date.now()))],
    [`POST`, `/ci/runs/jobs`, ciJobsRoute],
    [`POST`, `/ci/runs/rerun`, () => refuse(`This is the demo workspace: rerunning would start a pipeline on a repo that isn't yours.`)],
    [`POST`, `/ci/runs/cancel`, () => refuse(`This is the demo workspace: there is no live pipeline to cancel.`)],
    [
        `POST`,
        `/ci/fix`,
        () => refuse(`This is the demo workspace: a fix agent needs your repo and its CI logs. Start a sandbox and this button opens one.`),
    ],

    // GET /chores computes rows in the browser from fixture/chores.ts; the ledger is real state. Re-running
    // a probe refuses: it needs a subprocess this recording lacks.
    [`GET`, `/chores`, () => json(choresReport(Date.now()))],
    [`POST`, `/chores/ledger`, choresLedger],
    [`POST`, `/chores/probe`, () => refuse(`This is the demo workspace: a probe runs pnpm audit or knip against a real checkout.`)],

    // Enabling, editing, deleting and clearing a held wake are real (the fixture is the store); firing one
    // refuses, since a wake is a real agent turn.
    [`GET`, `/automations`, () => json({ automations: automationsList(Date.now()) })],
    // What can wake an agent and what it can start from, for the composer's source picker.
    [`GET`, `/automations/catalog`, () => json(automationCatalog())],
    [`GET`, `/automations/pending`, () => json({ approvals: automationApprovals(Date.now()) })],
    [`POST`, `/automations`, saveAutomationRoute],
    [`DELETE`, `/automations/{id}`, ({ param }) => okAfter(() => deleteAutomation(Date.now(), param(`id`)))],
    [`POST`, `/automations/{id}/run`, () => refuse(`This is the demo workspace: firing an automation runs a real turn against real systems.`)],
    [
        `POST`,
        `/automations/pending/{id}/approve`,
        () => refuse(`This is the demo workspace: approving a held wake would start the turn it is holding.`),
    ],
    [`POST`, `/automations/pending/{id}/reject`, ({ param }) => okAfter(() => resolveApproval(Date.now(), param(`id`)))],

    // Reading is real; running one refuses, since a run is several real agent sessions. Saving/deleting also
    // refuse: a kept design must not vanish on reload.
    [`GET`, `/workflows`, () => json({ workflows: demoWorkflows(runsOnBoard(Date.now())) })],
    [`GET`, `/workflows/runs`, () => json({ runs: runsOnBoard(Date.now()) })],
    [`POST`, `/workflows`, () => refuse(`This is the demo workspace: designs are read-only here.`)],
    [`DELETE`, `/workflows/{id}`, () => refuse(`This is the demo workspace: designs are read-only here.`)],
    [`POST`, `/workflows/{id}/run`, () => refuse(`This is the demo workspace: running a workflow starts several agent sessions on a real tree.`)],
    [`POST`, `/workflows/runs/{runId}/stop`, () => refuse(`This is the demo workspace: nothing is really running to stop.`)],
    // Archiving is one-way here with no way back, so it refuses instead of losing sessions silently.
    [
        `POST`,
        `/workflows/runs/{runId}/archive`,
        () => refuse(`This is the demo workspace: the archive here has no way back, so a run stays on the board.`),
    ],
    [`POST`, `/workflows/runs/{runId}/unarchive`, () => refuse(`This is the demo workspace: nothing has been archived to restore.`)],

    // Reading is real, showing two ways a message can rerun. Saving/deleting refuse, like every design here:
    // a kept one would vanish on reload.
    [`GET`, `/loops/designs`, () => json({ designs: demoLoops() })],
    [`POST`, `/loops/designs`, () => refuse(`This is the demo workspace: saved loops are read-only here.`)],
    [`DELETE`, `/loops/designs/{id}`, () => refuse(`This is the demo workspace: saved loops are read-only here.`)],

    // Served under the extension's own namespace and paths, so a boundary move is a compile error, not an
    // empty panel. Answers come from the extension's real engine over fixture/knowledge.ts.
    [`GET`, `${KNOWLEDGE_BASE}/overview`, () => json(knowledgeOverview())],
    [`GET`, `${KNOWLEDGE_BASE}/notes`, () => json({ notes: knowledgeNotes() })],
    [`GET`, `${KNOWLEDGE_BASE}/search`, ({ url }) => json({ hits: knowledgeSearch(url.searchParams) })],
    [`GET`, `${KNOWLEDGE_BASE}/note`, ({ url }) => knowledgeRead(url)],
    [`GET`, `${KNOWLEDGE_BASE}/graph`, ({ url }) => json(knowledgeGraph(url.searchParams))],
    [`PUT`, `${KNOWLEDGE_BASE}/note`, knowledgeWrite],
    [`DELETE`, `${KNOWLEDGE_BASE}/note`, knowledgeForget],
    // The demo knowledge base already started, so this only ever answers nothing to write.
    [`POST`, `${KNOWLEDGE_BASE}/seed`, () => json({ written: [] })],
    [`GET`, `/capabilities`, () => json({ capabilities: demoCapabilities() })],
    // The persona picker's data; three personas make the point without turning the column into a directory. A save
    // is real (the fixture is the store), so the project persona New agent makes under a scope shows in the picker.
    [`GET`, `/personas`, () => json({ personas: demoPersonas, connected: [`gmail-support`, `intercom`, `x-brand`, `linkedin`, `github`, `stripe-ops`] })],
    [`POST`, `/personas`, savePersonaRoute],
    // Every registry URL answers the same joined data; the real route would clone a repo and read two JSON
    // files from it.
    [`POST`, `/capabilities/marketplace`, () => json(demoRegistry())],
    [`GET`, `/usage/rollup`, () => json({ rows: demoUsageRollup(STARTED_AT) })],
    // What every connection read posts, on arrival and on the rail's refresh control alike. Nothing held: every demo
    // reading is taken, so the press moves the age rather than explaining why it couldn't.
    [`POST`, `/usage/plan-limits/refresh`, () => json({ ok: true, held: [] })],
    [`GET`, `/secrets/inventory`, () => json({ secrets: [] })],
    [`GET`, `/ports`, () => json({ ports: [] })],
    // Facts each extension's detect() runs over, for which tiles the rail carries; starting a dev server refuses.
    [`GET`, `/panels`, () => json({ panels: demoPanels() })],
    [`POST`, `/panels/{repo}/start`, () => refuse(`This is the demo workspace: a dev server needs the repository on your own machine.`)],
    [`POST`, `/panels/{repo}/stop`, () => refuse(`This is the demo workspace: nothing is running to stop.`)],
    // `invalid` is required by the contract; omitting it fails the whole list to parse.
    [`GET`, `/extensions`, () => json({ extensions: demoExtensions(), invalid: [] })],
    // The listed extensions' bundles, served as a daemon serves an installed checkout's `entry`; the loader blob-imports
    // them, so the demo runs the published bytes rather than a compiled-in copy.
    [`GET`, `/extensions/{id}/bundle`, ({ param }) => vendoredBundle(param(`id`))],
    [`POST`, `/extensions/{id}/enabled`, setEnabled],
    // Loaded before an extension's activate(), so `api.settings.get` is synchronous; missing here means the
    // extension never activates.
    [`GET`, `/extensions/{id}/settings`, () => json({ settings: {}, secretsSet: [] })],
    [`POST`, `/extensions/{id}/settings`, () => json({ ok: true })],
    [`GET`, `/approvals`, () => json({ approvals: [], invalid: [] })],
    [`GET`, `/members`, () => json({ members: [] })],
    // Two tokens on the roster (one unused, one expiring) make the roster's states visible; a mint answers
    // the once-shown value.
    [
        `GET`,
        `/system/control/tokens`,
        () =>
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
    ],
    [`POST`, `/system/control/tokens`, () => json({ id: `ct_new`, token: `ict_demo-shown-once-Q7xk2Lm9vRt4Bw8zN1pC3sYf6Hd0Ja5Ke` })],
    [`DELETE`, `/system/control/tokens/{id}`, () => json({ ok: true })],
    [`GET`, `/environment`, () => json(demoEnvironment())],
    [`GET`, `/environment/contents`, () => json(demoEnvironmentContents())],
    // Read on first render; a published workspace and empty exports/computers are the tab's default states
    // before the visitor clicks anything.
    [`GET`, `/definition/workspace`, () => json({ remote: `https://github.com/acme/intentic-sandbox-ada.git`, branch: `main`, hosts: [`github.com`] })],
    [`GET`, `/bundles`, () => json({ exports: [] })],
    [`GET`, `/arrivals/hosts`, () => json({ hosts: [] })],
    // The checklist an upload produces: one row per repo, one for workspace files, one for history, plus two
    // steps the arrival can't do for the owner.
    [
        `POST`,
        `/arrivals/plan`,
        () =>
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
    ],
];

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

const CODEX_MODELS: Model[] = [
    { id: `gpt-5.2-codex`, label: `GPT-5.2 Codex`, efforts: [`low`, `medium`, `high`], badges: [`reasoning`] },
    { id: `gpt-5.2`, label: `GPT-5.2`, efforts: [`low`, `medium`, `high`] },
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
const DEMO_CATALOGS: Record<string, { models: Model[]; default: string }> = {
    claude: { models: CLAUDE_MODELS, default: `claude-sonnet-5` },
    codex: { models: CODEX_MODELS, default: `gpt-5.2-codex` },
    gemini: { models: GEMINI_MODELS, default: `gemini-3-1-pro` },
};

// An empty rule table puts a finished agent in Ready to land, with nothing else deciding otherwise. One role is
// pinned to a provider with no credential here: a pin is written, not resolved, so "not connected" is a state the
// settings page has to be able to draw, and the only way to see it is to have one.
const DEMO_SETTINGS = {
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
    sidecars: true,
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
    dependencies: {
        checked: 14,
        improved: 5,
        updatedAt: STARTED_AT - 12 * 60_000,
        recent: [
            { prevented: `moment@2.29.4`, chosen: `date-fns`, reason: `moment is in maintenance mode and ships no new features`, at: STARTED_AT - 12 * 60_000 },
            { prevented: `rimraf@3.0.2`, chosen: `node:fs rm with recursive: true`, reason: `the platform has covered this since Node 14`, at: STARTED_AT - 45 * 60_000 },
            { prevented: `request@2.88.2`, chosen: `undici`, reason: `it was deprecated in 2020 and takes no fixes`, at: STARTED_AT - 180 * 60_000 },
            { prevented: `uuid@8.3.2`, chosen: `crypto.randomUUID`, reason: `the platform has covered v4 since Node 14.17`, at: STARTED_AT - 360 * 60_000 },
            { prevented: `vue@3.5.20`, chosen: `3.5.22`, reason: `the registry's latest is 3.5.22, behind by patches`, at: STARTED_AT - 720 * 60_000 },
        ],
    },
};

const agentResponse = (agent: AgentSummary | undefined): Response => (agent === undefined ? refuse(`No such agent.`, 404) : json(agent));

// The demo's own reader is Ada (the session this daemon mints), so a press here joins or leaves her from the chip,
// exactly as the real one attributes a mark to the verified caller rather than to anything the browser sent.
function reactToAgent({ request, param }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        const { emoji, on } = body as { emoji?: string; on?: boolean };
        const agent = roster.agents.find((candidate) => candidate.id === param(`id`));
        if (agent === undefined || emoji === undefined) {
            return agentResponse(undefined);
        }
        const me = { email: OWNER.email, ...(OWNER.name === undefined ? {} : { name: OWNER.name }), at: Date.now() };
        // Only the pressed emoji is rewritten: her marks on the other chips are not what this press was about.
        const held = agent.reactions ?? [];
        const opened = on === true && !held.some((chip) => chip.emoji === emoji) ? [...held, { emoji, by: [] }] : held;
        const marked = opened.map((chip) => {
            if (chip.emoji !== emoji) {
                return chip;
            }
            const without = chip.by.filter((who) => who.email !== OWNER.email);
            return { ...chip, by: on === true ? [...without, me] : without };
        });
        const reactions = marked.filter((chip) => chip.by.length > 0);
        return agentResponse(patchAgent(param(`id`), reactions.length > 0 ? { reactions } : { reactions: undefined }));
    });
}

// Changes hands as the real route does: a name is known only for the reader's own address; anyone else is an address
// until presence says otherwise.
function assignAgent({ request, param }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        const to = (body as { to?: string }).to?.trim().toLowerCase();
        if (to === undefined || to === ``) {
            return refuse(`An address is required.`, 400);
        }
        const name = to === OWNER.email.toLowerCase() ? OWNER.name : undefined;
        return agentResponse(patchAgent(param(`id`), { owner: { email: to, ...(name === undefined ? {} : { name }), since: Date.now() } }));
    });
}

function renameAgent({ request, param }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        const title = (body as { title?: string }).title;
        return agentResponse(patchAgent(param(`id`), title === undefined ? {} : { title }));
    });
}

function archiveAgents({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        const ids = (body as { ids?: string[] }).ids ?? [];
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
        return json({ moved: archived, failed: [], rev: roster.rev });
    });
}

/** A mutation with nothing to report: do it, then answer the daemon's own `{ ok: true }`. */
const okAfter = (write: () => void): Response => {
    write();
    return json({ ok: true });
};

function ciJobsRoute({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        const { repo, runId } = body as { repo?: string; runId?: number };
        return json({ jobs: ciJobs(repo ?? ``, runId ?? 0, Date.now()) } satisfies CiJobsResponse);
    });
}

function saveAutomationRoute({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => okAfter(() => saveAutomation(Date.now(), body as Automation)));
}

// Upsert by id, as the daemon's `/personas` does; the list is the store, so a saved card is in the next read.
const demoPersonas: Persona[] = [
    { id: `maya-support`, label: `Maya · Customer Care`, capabilities: [`gmail-support`, `intercom`], workspace: { startIn: `web` } },
    { id: `owen-growth`, label: `Owen · Growth`, capabilities: [`x-brand`, `linkedin`] },
    { id: `priya-ops`, label: `Priya · Operations`, capabilities: [`github`, `stripe-ops`] },
];
function savePersonaRoute({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) =>
        okAfter(() => {
            const card = body as Persona;
            const index = demoPersonas.findIndex((persona) => persona.id === card.id);
            if (index === -1) {
                demoPersonas.push(card);
            } else {
                demoPersonas[index] = card;
            }
        }),
    );
}

// A missing path answers "nothing there" in a 200 body, not a 404; several surfaces read a file just to
// check existence.
const workspaceRead = (path: string): Response => json(readFile(path));

const documentBytes = (bytes: Uint8Array<ArrayBuffer>): Response =>
    new Response(bytes, { status: 200, headers: { "content-type": `application/vnd.openxmlformats-officedocument.wordprocessingml.document` } });

// One version of the document as the text a daemon's fileq would render from it (the diff's Text reading).
const derivedSide = (content: string): object => ({ present: true, content, deriver: `docx v2`, notes: [], truncated: false });

// Report screenshots (svg keeps them a few kilobytes and sharp at any size) and the one document, which is the only
// path here whose bytes are bytes: a viewer parses it, so text would not do.
const workspaceRaw = (path: string): Response => {
    if (path === SUPPLIER_LETTER_PATH) {
        return documentBytes(SUPPLIER_LETTER_DOCX);
    }
    if (path === HANDOVER_PATH || path === HANDOVER_CHANGE_PATH) {
        return documentBytes(HANDOVER_DOCX);
    }
    const body = fileBody(path);
    if (body === undefined) {
        return refuse(`No such file: ${path}`, 404);
    }
    return new Response(body, { status: 200, headers: { "content-type": path.endsWith(`.svg`) ? `image/svg+xml` : `text/plain; charset=utf-8` } });
};

function workspaceUpload({ request, url }: RouteContext): Promise<Response> {
    const path = url.searchParams.get(`path`) ?? ``;
    return request.text().then((body) => okAfter(() => writeFile(path, body)));
}

function workspaceDelete({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => okAfter(() => deleteEntry((body as { path?: string }).path ?? ``)));
}

function choresLedger({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => okAfter(() => writeLedger(Date.now(), ChoreLedgerWriteSchema.parse(body))));
}

const knowledgeRead = (url: URL): Response => {
    const note = knowledgeNoteAt(url.searchParams.get(`path`) ?? ``);
    return note === undefined ? refuse(`No such note.`, 404) : json(note);
};

// Refuses exactly what the real backend refuses: a path outside the knowledge folder, or not a note.
function knowledgeWrite({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        const { path, content } = body as { path?: string; content?: string };
        return saveKnowledgeNote(Date.now(), path ?? ``, content ?? ``)
            ? json({ ok: true })
            : refuse(`That is not a markdown note inside the knowledge folder.`, 400);
    });
}

function knowledgeForget({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        const path = (body as { path?: string }).path ?? ``;
        return deleteKnowledgeNote(Date.now(), path) ? json({ ok: true }) : refuse(`No such note.`, 404);
    });
}

function setEnabled({ request, param }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        setExtensionEnabled(param(`id`), (body as { enabled?: boolean }).enabled === true);
        return json({ extensions: demoExtensions(), invalid: [] });
    });
}

function stopTurn({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        const conversationId = (body as { conversationId?: string }).conversationId;
        if (conversationId !== undefined) {
            runs.get(conversationId)?.stop();
            patchAgent(conversationId, { status: `stopped`, updatedAt: Date.now() });
        }
        return json({ ok: true });
    });
}

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

// Match one route pattern against a path, capturing `{param}` segments.
const match = (pattern: string, path: string): Record<string, string> | undefined => {
    const patternParts = pattern.split(`/`);
    const pathParts = path.split(`/`);
    if (patternParts.length !== pathParts.length) {
        return undefined;
    }
    const params: Record<string, string> = {};
    for (const [index, part] of patternParts.entries()) {
        const actual = pathParts[index] ?? ``;
        if (part.startsWith(`{`) && part.endsWith(`}`)) {
            params[part.slice(1, -1)] = decodeURIComponent(actual);
            continue;
        }
        if (part !== actual) {
            return undefined;
        }
    }
    return params;
};

/** How much of the real daemon this fixture stands in for, reported once at boot, so the gap is visible. */
export const coverage = (): { served: number; contract: number } => ({ served: ROUTES.length, contract: SANDBOX_ROUTE_NAMES.length });

export const daemon = async (request: Request, url: URL): Promise<Response> => {
    for (const [method, pattern, handler] of ROUTES) {
        if (method !== request.method) {
            continue;
        }
        const params = match(pattern, url.pathname);
        if (params !== undefined) {
            return handler({ request, url, param: (name) => params[name] ?? `` });
        }
    }
    // Logged rather than silent, so a missing fixture route is easy to find.
    console.info(`[demo] no fixture route for ${request.method} ${url.pathname}`);
    return json({ error: `The demo fixture doesn't serve ${request.method} ${url.pathname}.` }, 404);
};
