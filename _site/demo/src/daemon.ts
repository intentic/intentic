import {
    type AgentSearchResult,
    type AgentsList,
    type AgentSummary,
    AgentReplySchema,
    type Automation,
    type BrowsersList,
    ChoreLedgerWriteSchema,
    type CiJobsResponse,
    type CiSeenResponse,
    type Info,
    type Model,
    type OauthAccount,
    type OauthAccountList,
    type PresenceUser,
    SANDBOX_ROUTE_NAMES,
    type SavingsReport,
    type SubagentsList,
    type SystemEvent,
    type TerminalsList,
    type TranslatorAccounts,
    type WorkflowRun,
} from "@intentic/sandbox-contract";
import { KNOWLEDGE_BASE } from "@intentic/ext-knowledge";
import { MEMORY_BASE } from "@intentic/ext-memory";
import { BROWSER_SESSIONS } from "./browser";
import { automationApprovals, automationsList, deleteAutomation, resolveApproval, saveAutomation } from "./fixture/automations";
import { demoLoops } from "./fixture/loops";
import { demoRuns, demoWorkflows } from "./fixture/workflows";
import { choresReport, writeLedger } from "./fixture/chores";
import { ciJobs, ciRunsResponse } from "./fixture/ci";
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
import { deleteMemoryFile, memoryFile, memoryList, saveMemoryFile } from "./fixture/memory";
import { demoRegistry } from "./fixture/registry";
import {
    demoCapabilities,
    demoEnvironment,
    demoEnvironmentContents,
    demoExtensions,
    demoPanels,
    demoUsageRollup,
    setExtensionEnabled,
} from "./fixture/sandbox";
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
    REPOS,
    searchWorkspace,
    sessions,
    workspaceChildren,
    workspaceTree,
    writeFile,
} from "./fixture/workspace";
import { demoMode } from "./mode";
import { eventStream } from "./sse";
import { featuredRun, type Run, visitorRun } from "./turn";
import { json, refuse } from "./transport";

/* THE DAEMON, as a fetch handler in the tab.
 *
 * Every route below answers in the shape the contract declares for it — the handlers are annotated with the
 * contract's own types, so a shape that drifts is a build error rather than a demo that quietly renders
 * nothing. What it deliberately is NOT is an oRPC server: the daemon's real `OpenAPIHandler` would want
 * `@orpc/server` in the browser bundle to re-validate payloads this file is the only writer of.
 *
 * Three classes of mutation, decided per route:
 *   real     — rename, archive, seen, sending a message: the fixture is mutable state and the UI is honest.
 *   refused  — land, push, discard, secrets: `refuse()` gives the app the daemon's own error shape, so the
 *              message lands where a real refusal would instead of failing silently.
 *   missing  — everything not listed: a 404 the app already knows how to narrate.
 */

const STARTED_AT = Date.now();

/* The roster is live state: rename/archive/seen write it, and every write bumps `rev` and re-broadcasts, which
 * is exactly the contract the real registry has with the board (snapshot-not-diff, newest rev wins).
 *
 * How much of the cast it starts with is the demo mode's call (mode.ts) — the fleet fixture stays the whole
 * roster, and a mode is a view onto it. */
const roster = { agents: fleetRoster(STARTED_AT).filter((agent) => demoMode.agents?.includes(agent.id) ?? true), rev: 1 };
// When the pipelines board was last read. Seeded just before the newest breakage, so the rail badge a visitor
// arrives to is honest — and opening the view stamps it away, as it does against a real daemon.
let ciSeenAt = STARTED_AT - 35 * 60_000;
const listeners = new Set<(event: SystemEvent) => void>();
const runs = new Map<string, Run>();

const broadcastRoster = (): void => {
    roster.rev += 1;
    const frame: SystemEvent = { kind: `agents`, agents: roster.agents, rev: roster.rev };
    for (const listener of listeners) {
        listener(frame);
    }
};

/* The recorded workflow run, as far as THIS board can see it. The fleet view draws a run's group card from
 * /workflows/runs rather than from the roster (useWorkflowRuns.ts), so a mode whose board does not carry the
 * two review agents must not be told about the run they are steps of — the card would be a doorway to cards
 * that are not there. Keyed on the live steps, because a finished step's conversation is history either way. */
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

// Who is in the workspace. The second one is the whole sharing story told in one frame — and the first thing a
// minimal recording drops, because an avatar nobody asked for is furniture.
const OWNER: PresenceUser = { clientId: `demo-owner`, email: `ada@acme.dev`, name: `Ada Lovelace`, role: `owner`, idle: false, view: `workspace` };
const TEAMMATE: PresenceUser = {
    clientId: `demo-mate`,
    email: `grace@acme.dev`,
    name: `Grace Hopper`,
    role: `collaborator`,
    idle: true,
    view: `agents`,
};

/* The /events stream: the hello identity frame, then a heartbeat inside the browser's 10s watchdog, plus the
 * roster and the presence of whoever this mode has in the workspace.
 *
 * `routes` is deliberately omitted from the hello. useDaemonRoutes reads its absence as "assume supported", so
 * no feature gates itself off on a daemon that never advertised — and the fixture doesn't have to keep a list
 * of route names in step with the contract. (SANDBOX_ROUTE_NAMES is imported only for the `info` build string,
 * so the count in the UI is honest about how much surface this fixture stands in for.) */
const HEARTBEAT_MS = 2_000;

/* How often the fixture claims its running things moved.
 *
 * The real daemon watches its own tmux, sockets and registries and pushes `runtimeChanged` when what it sees
 * changes; those views hold no timer of their own any more. This fixture's rosters are CONSTANTS built against
 * the moment they are read (`activityAt: now - 4_000`), so with nothing pushing they would freeze — a browser
 * the demo shows as running, last active five minutes ago. Standing in for the real feed keeps the recording
 * honest and costs one small frame every few seconds. */
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
    if (conversationId !== FEATURED_AGENT_ID) {
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
        // Nothing is running on this conversation — the same empty stream a real daemon answers with.
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

/* The conversation-id prefixes the rail's own areas derive their fan-outs from: `xt-` an acceptance run, `dg-` a
 * documentation run, `mt-` a chore turn. A visitor pressing Run there is asking for N isolated agents against a
 * checkout that does not exist here, so the turn is refused in the daemon's own error shape and the extension
 * shows the reason where it shows any other refusal. The visitor's OWN chat turn — no prefix — still runs. */
const EXTENSION_RUN_PREFIXES = [`xt-`, `dg-`, `mt-`];

const startTurn = async (request: Request): Promise<Response> => {
    const body = (await request.json()) as { conversationId?: string; prompt?: string };
    const conversationId = body.conversationId ?? FEATURED_AGENT_ID;
    if (EXTENSION_RUN_PREFIXES.some((prefix) => conversationId.startsWith(prefix))) {
        return refuse(`This is the demo workspace — a run needs your repositories and a sandbox to walk them in. Start one and this button works.`);
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
    patchAgent(AWAITING_AGENT_ID, {
        attention: { plan: false, question: false, permission: false, service: false, capability: false, conflict: false },
    });
    return json({ ok: true });
};

/* LAND NOW — the press the whole fleet board is pointed at, and the one mutation here that changes more than
 * one surface. A clean land moves the agent's delta into the main tree (fixture/workspace.ts), so the card
 * crosses into Finished, the review's rows flip to "landed", the Changes panel grows the files with this
 * agent's chip on them, and `workspaceChanged` tells every open panel to re-read. A refused one changes
 * nothing at all, which is exactly the promise `check` makes — the card goes back to conflict carrying the
 * report the panel then offers to hand to the agent. */
const land = (id: string): Response => {
    const result = landAgentDelta(id);
    if (!result.landed) {
        patchAgent(id, {
            status: `conflict`,
            updatedAt: Date.now(),
            attention: { plan: false, question: false, permission: false, service: false, capability: false, conflict: true },
        });
        return json(result);
    }
    patchAgent(id, {
        status: `landed`,
        updatedAt: Date.now(),
        attention: { plan: false, question: false, permission: false, service: false, capability: false, conflict: false },
    });
    const paths = landedPaths(id);
    for (const listener of listeners) {
        listener({ kind: `workspaceChanged`, paths });
    }
    return json(result);
};

const info: Info = { name: `acme-shop`, version: `demo`, latest: `demo`, updateAvailable: false };

/* The route table. Ordered, first match wins; `{name}` matches one segment, read back through `param`.
 *
 * Reads that are simply EMPTY here (browsers, subagents, drafts, ports, extensions, …) answer their contract's
 * empty shape rather than 404: an area that renders "nothing yet" is telling the truth about this fixture,
 * while a 404 would make the app narrate a daemon that predates the route. */
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
    // No loopback shortcut to adopt: the demo daemon is only ever at its own origin (see transport.ts).
    [`GET`, `/health`, () => json({ error: `The demo has no local daemon to shortcut to.` }, 404)],
    [`POST`, `/system/session`, () => json({ token: `demo-session`, expiresAt: Date.now() + 30 * 24 * 3_600_000, email: `ada@acme.dev` })],
    [`POST`, `/system/presence`, () => json({ ok: true })],
    // A WebSocket can't carry a bearer header, so the terminal and the browser view spend one of these per
    // upgrade (wsTicket.ts). Answered rather than left to its 404 fallback: the fallback works, but it puts a
    // failed request in the console of every demo.
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
    // The agent's Chromium: one still being driven (its screencast is browser.ts) and one that has closed,
    // which is the state the view renders as a record of where the agent went rather than as a broken stream.
    [`GET`, `/system/browsers`, () => json({ sessions: BROWSER_SESSIONS(Date.now()) } satisfies BrowsersList)],
    [
        `DELETE`,
        `/system/browsers/{name}`,
        () => refuse(`This is the demo workspace — the browser you are watching is a recording, so there is nothing to close.`),
    ],
    // `sessions`, not `subagents` — SubagentsListSchema's field, which the client parses and the rail counts.
    // Under the wrong key every read threw and vue-query retried it, so the one roster the demo has nothing to
    // show for was also the busiest thing on its network tab.
    [`GET`, `/system/subagents`, () => json({ sessions: [] } satisfies SubagentsList)],

    // `held` is the same approvals queue /automations/pending serves, projected onto the board — so the demo's
    // "needs you" wake sits beside the running cards, as it does in the real fleet.
    [`GET`, `/agents`, () => json({ agents: roster.agents, rev: roster.rev, held: automationApprovals(Date.now()) } satisfies AgentsList)],
    [`GET`, `/agents/archived`, () => json({ agents: [], rev: roster.rev, held: [] } satisfies AgentsList)],
    [`GET`, `/agents/search`, ({ url }) => json(searchAgents(url.searchParams.get(`query`) ?? ``, url.searchParams.get(`caseSensitive`) === `true`))],
    [`POST`, `/agents/seen`, () => json({ agents: roster.agents, rev: roster.rev, held: automationApprovals(Date.now()) } satisfies AgentsList)],
    [`GET`, `/agents/{id}/diff`, ({ param }) => json(agentChanges(param(`id`)))],
    // Opening a card that is NOT mid-turn reads its transcript rather than attaching — so the one agent holding
    // a finished delta carries the conversation that produced it (fixture/transcripts.ts).
    [`GET`, `/agents/{id}/transcript`, ({ param }) => json(transcriptFor(param(`id`)))],
    [`GET`, `/agents/{id}/{repo}/file-diff`, ({ url, param }) => json(fileDiff(param(`repo`), url.searchParams.get(`path`) ?? ``))],
    [`POST`, `/agents/{id}/rename`, renameAgent],
    [`POST`, `/agents/{id}/seen`, ({ param }) => agentResponse(patchAgent(param(`id`), { seenAt: Date.now() }))],
    [`POST`, `/agents/{id}/auto-land`, ({ param }) => agentResponse(patchAgent(param(`id`), {}))],
    [`POST`, `/agents/{id}/land`, ({ param }) => land(param(`id`))],
    [`POST`, `/agents/{id}/discard`, () => refuse(`This is the demo workspace — there is no worktree to discard.`)],
    [`POST`, `/agents/archive`, archiveAgents],
    [`POST`, `/agents/unarchive`, () => json({ agents: [], rev: roster.rev })],

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

    /* The recording's filesystem (fixture/workspace.ts), served the way the daemon serves /work: a tree, a lazy
     * listing per directory, a read that says "nothing there" for a path that is not there — and real WRITES,
     * because the surfaces reading these files also acknowledge, author and publish through them. What a visitor
     * writes holds until the tab is reloaded. */
    [`GET`, `/workspace/tree`, () => json(workspaceTree())],
    [`GET`, `/workspace/children`, ({ url }) => json(workspaceChildren(url.searchParams.get(`path`) ?? ``))],
    [`GET`, `/workspace/file`, ({ url }) => workspaceRead(url.searchParams.get(`path`) ?? ``)],
    // The bytes behind an <img> in an acceptance report: its screenshots are files like any other, fetched
    // through the daemon rather than from an origin, which is why they are served here and not from /public.
    [`GET`, `/workspace/raw`, ({ url }) => workspaceRaw(url.searchParams.get(`path`) ?? ``)],
    // The drop's two calls: the pre-flight that asks which files the sandbox already has byte-for-byte (nothing
    // here is ever a re-drop, so none of them), then the per-file write the upload queue makes over XHR.
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
    [`GET`, `/git/{repo}/branches`, ({ param }) => json({ branches: [{ name: `main`, current: true }], repo: param(`repo`) })],
    [`POST`, `/git/{repo}/commit`, () => refuse(`This is the demo workspace — commits need a real repository.`)],
    [`POST`, `/git/{repo}/push`, () => refuse(`This is the demo workspace — there is no remote to push to.`)],

    /* The connected AI accounts and each provider's live model catalog. Without these the composer sits on
     * "Checking your AI accounts…" forever: the chat gates itself on knowing what it could run a turn WITH. One
     * connected Claude subscription and one Codex account is the honest shape of a working sandbox. */
    [`GET`, `/claude/accounts`, () => json({ accounts: [DEMO_CLAUDE_ACCOUNT] } satisfies OauthAccountList)],
    [`GET`, `/grok/accounts`, () => json({ accounts: [] } satisfies OauthAccountList)],
    // Codex authenticates ONLY through the translator (see access.ts), so this — not an oauth account — is what
    // makes the fleet's two Codex agents legible: a connected ChatGPT subscription their turns ran on.
    [`GET`, `/translator/accounts`, () => json(DEMO_TRANSLATOR_ACCOUNTS)],
    // One route for every provider's catalog, as the daemon serves it. A provider the demo has not connected
    // answers empty, which is exactly what an unconnected provider looks like against the real daemon too.
    [`GET`, `/providers/{provider}/models`, ({ param }) => json(DEMO_CATALOGS[param(`provider`)] ?? { models: [], default: `` })],

    [`GET`, `/settings`, () => json(DEMO_SETTINGS)],
    [`GET`, `/settings/savings`, () => json(DEMO_SAVINGS)],
    // No rule has ever fired in a recorded demo, which is the honest answer for a table with no rules in it.
    [`GET`, `/settings/rule-firings`, () => json({})],
    [`GET`, `/vpn`, () => json({ networks: [] })],

    /* CI. The board is real data (fixture/ci.ts) and its read state is real state: opening the view stamps
     * `/ci/seen`, which is what clears the rail's breakage badge. What a recording cannot do is act on someone
     * else's pipeline, so rerun, cancel and Fix-with-agent refuse in the daemon's own error shape — the view
     * renders that line above the board, which is the whole point of refusing rather than pretending. */
    [`GET`, `/ci/runs`, () => json(ciRunsResponse(Date.now(), ciSeenAt))],
    [`POST`, `/ci/runs/jobs`, ciJobsRoute],
    [`POST`, `/ci/seen`, () => json({ seenAt: (ciSeenAt = Date.now()) } satisfies CiSeenResponse)],
    [`POST`, `/ci/runs/rerun`, () => refuse(`This is the demo workspace — rerunning would start a pipeline on a repo that isn't yours.`)],
    [`POST`, `/ci/runs/cancel`, () => refuse(`This is the demo workspace — there is no live pipeline to cancel.`)],
    [
        `POST`,
        `/ci/fix`,
        () => refuse(`This is the demo workspace — a fix agent needs your repo and its CI logs. Start a sandbox and this button opens one.`),
    ],

    /* MAINTENANCE. `GET /chores` carries measurements, never verdicts — the chore book that decides what is due
     * ships in the app, so every row a visitor reads here is computed in the browser from the numbers in
     * fixture/chores.ts. The ledger is real state (a snooze holds, a finished run promotes into a row); what
     * refuses is re-running a probe, because that is a subprocess in a box this recording does not have. */
    [`GET`, `/chores`, () => json(choresReport(Date.now()))],
    [`POST`, `/chores/ledger`, choresLedger],
    [`POST`, `/chores/probe`, () => refuse(`This is the demo workspace — a probe runs pnpm audit or knip against a real checkout.`)],

    /* Automations — the sandbox working while nobody watches. Enabling, editing and deleting a row are real
     * (the fixture is the store), and so is clearing a held wake; what refuses is FIRING one, because a wake is
     * an agent turn against a repo the recording doesn't have. */
    [`GET`, `/automations`, () => json({ automations: automationsList(Date.now()) })],
    [`GET`, `/automations/pending`, () => json({ approvals: automationApprovals(Date.now()) })],
    [`POST`, `/automations`, saveAutomationRoute],
    [`DELETE`, `/automations/{id}`, ({ param }) => okAfter(() => deleteAutomation(Date.now(), param(`id`)))],
    [`POST`, `/automations/{id}/run`, () => refuse(`This is the demo workspace — firing an automation runs a real turn against real systems.`)],
    [
        `POST`,
        `/automations/pending/{id}/approve`,
        () => refuse(`This is the demo workspace — approving a held wake would start the turn it is holding.`),
    ],
    [`POST`, `/automations/pending/{id}/reject`, ({ param }) => okAfter(() => resolveApproval(Date.now(), param(`id`)))],

    /* Workflows — a designed graph of sessions, with one run of it going on right now. Reading is real (the
     * designer opens on the saved graph, the run page draws the run the board's two review cards are steps
     * of); what refuses is RUNNING one, because a run is several agent sessions against a real tree. Saving and
     * deleting refuse for the same reason the run does: a design the demo let you keep would be a design that
     * silently vanishes on reload, which teaches worse than a clear no. */
    [`GET`, `/workflows`, () => json({ workflows: demoWorkflows(runsOnBoard(Date.now())) })],
    [`GET`, `/workflows/runs`, () => json({ runs: runsOnBoard(Date.now()) })],
    [`POST`, `/workflows`, () => refuse(`This is the demo workspace — designs are read-only here.`)],
    [`DELETE`, `/workflows/{id}`, () => refuse(`This is the demo workspace — designs are read-only here.`)],
    [`POST`, `/workflows/{id}/run`, () => refuse(`This is the demo workspace — running a workflow starts several agent sessions on a real tree.`)],
    [`POST`, `/workflows/runs/{runId}/stop`, () => refuse(`This is the demo workspace — nothing is really running to stop.`)],
    // Archiving a run takes its step SESSIONS off the board with it, and this fixture's archive is a one-way
    // disappearance rather than a list you can open — so it refuses, in the demo's own voice, instead of
    // swallowing four conversations the visitor could never get back.
    [
        `POST`,
        `/workflows/runs/{runId}/archive`,
        () => refuse(`This is the demo workspace — the archive here has no way back, so a run stays on the board.`),
    ],
    [`POST`, `/workflows/runs/{runId}/unarchive`, () => refuse(`This is the demo workspace — nothing has been archived to restore.`)],

    /* Saved loops — the workflows page's second kind of design, and the other half of the composer's
     * run-through picker. Reading is real, so the picker shows what it is actually for: two ways for a message
     * to be run over and over, each saying what stops it. Saving and deleting refuse for the reason every
     * design here refuses — a loop the demo let you keep would vanish on reload, which teaches worse than a
     * clear no. */
    [`GET`, `/loops/designs`, () => json({ designs: demoLoops() })],
    [`POST`, `/loops/designs`, () => refuse(`This is the demo workspace — saved loops are read-only here.`)],
    [`DELETE`, `/loops/designs/{id}`, () => refuse(`This is the demo workspace — saved loops are read-only here.`)],

    /* Memory: what the agent carries between sessions, readable and — the point of the surface — editable. The
     * red pen writes into the fixture, so an edit and a forget both hold until the tab is reloaded.
     *
     * Served under the memory extension's OWN namespace, because that is where its backend half lives now and
     * therefore what its panel calls; the paths come from the extension rather than being spelled out here, so
     * the next move of that boundary lands as a compile error instead of an empty panel. */
    [`GET`, `${MEMORY_BASE}/memory`, () => json({ files: memoryList(Date.now()) })],
    [`GET`, `${MEMORY_BASE}/memory/file`, ({ url }) => memoryRead(url)],
    [`PUT`, `${MEMORY_BASE}/memory/file`, memoryWrite],
    [`DELETE`, `${MEMORY_BASE}/memory/file`, memoryForget],

    /* Knowledge: the vault of things around the code — people, projects, decisions, words — and the graph they
     * already form. Served under the extension's own namespace, like memory above.
     *
     * The answers are computed by the extension's OWN engine over the fixture's raw markdown (fixture/knowledge.ts),
     * not hand-authored: backlinks, the neighbourhood map and the drift report are the real ones, so a visitor
     * clicking through the demo is seeing what the product does rather than a picture of it. */
    [`GET`, `${KNOWLEDGE_BASE}/overview`, () => json(knowledgeOverview())],
    [`GET`, `${KNOWLEDGE_BASE}/notes`, () => json({ notes: knowledgeNotes() })],
    [`GET`, `${KNOWLEDGE_BASE}/search`, ({ url }) => json({ hits: knowledgeSearch(url.searchParams) })],
    [`GET`, `${KNOWLEDGE_BASE}/note`, ({ url }) => knowledgeRead(url)],
    [`GET`, `${KNOWLEDGE_BASE}/graph`, ({ url }) => json(knowledgeGraph(url.searchParams))],
    [`PUT`, `${KNOWLEDGE_BASE}/note`, knowledgeWrite],
    [`DELETE`, `${KNOWLEDGE_BASE}/note`, knowledgeForget],
    // The demo vault is already started, so this only ever answers "nothing to write" — which is the honest
    // answer and the same one a real started vault gives.
    [`POST`, `${KNOWLEDGE_BASE}/seed`, () => json({ written: [] })],
    [`GET`, `/capabilities`, () => json({ capabilities: demoCapabilities() })],
    /* Browsing a registry — what the Sandbox screen's Discover row renders. The real route clones a git repo
     * and reads two JSON files out of it; this answers with them already joined. Every registry URL gets the
     * same answer, which is honest enough for a demo: pointing the field at an internal repo is a real feature
     * and there is no internal repo here to point it at. */
    [`POST`, `/capabilities/marketplace`, () => json(demoRegistry())],
    [`GET`, `/usage/rollup`, () => json({ rows: demoUsageRollup(STARTED_AT) })],
    [`GET`, `/secrets/inventory`, () => json({ secrets: [] })],
    [`GET`, `/ports`, () => json({ ports: [] })],
    // What each repository IS — the facts every extension's detect() runs over, and therefore which tiles the
    // rail carries. Starting a dev server refuses: there is no checkout here to run one from.
    [`GET`, `/panels`, () => json({ panels: demoPanels() })],
    [`POST`, `/panels/{repo}/start`, () => refuse(`This is the demo workspace — a dev server needs the repository on your own machine.`)],
    [`POST`, `/panels/{repo}/stop`, () => refuse(`This is the demo workspace — nothing is running to stop.`)],
    // `invalid` is not optional in the contract, and answering without it fails the whole list to parse — which
    // reads as "couldn't list this sandbox's extensions" over an empty tab. Nothing here is unreadable: every
    // extension is compiled into this build.
    [`GET`, `/extensions`, () => json({ extensions: demoExtensions(), invalid: [] })],
    [`POST`, `/extensions/{id}/enabled`, setEnabled],
    /* An extension's own settings, which the host loads BEFORE calling activate() so `api.settings.get` is
     * synchronous from the first line of it. Missing here, the load rejected and the extension never activated
     * — a whole surface silently absent from the demo, with nothing in the console but a routine "no fixture
     * route" line. Answered as the defaults (empty), because a demo visitor configures nothing. */
    [`GET`, `/extensions/{id}/settings`, () => json({ settings: {}, secretsSet: [] })],
    [`POST`, `/extensions/{id}/settings`, () => json({ ok: true })],
    [`GET`, `/drafts`, () => json({ drafts: [] })],
    [`GET`, `/members`, () => json({ members: [] })],
    [`GET`, `/environment`, () => json(demoEnvironment())],
    [`GET`, `/environment/contents`, () => json(demoEnvironmentContents())],
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

// What each provider's catalog route answers. Claude and Codex are the two this demo has connected; every other
// provider is absent rather than listed empty, so the route's own fallback is the single place "nothing
// connected" is spelled.
const DEMO_CATALOGS: Record<string, { models: Model[]; default: string }> = {
    claude: { models: CLAUDE_MODELS, default: `claude-sonnet-5` },
    codex: { models: CODEX_MODELS, default: `gpt-5.2-codex` },
};

// The sandbox-wide agent settings the chat and the hub read. An EMPTY rule table is what puts a finished agent
// in "Ready to land" — with no rule saying otherwise, work waits on its branch, which is the state the demo's
// review panel exists to show.
const DEMO_SETTINGS = { rules: [], systemPromptMode: `intentic`, stableSystemPrompt: true, skills: [] };

// What the tool-output cleaners were worth over the window the hub is showing. A measured claim, so the demo
// states it the way the product does: per-stage, with the ledger's own freshness.
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
};

const agentResponse = (agent: AgentSummary | undefined): Response => (agent === undefined ? refuse(`No such agent.`, 404) : json(agent));

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
        return json({ agents: archived, rev: roster.rev });
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

/* The four filesystem handlers. A read of a path the recording does not carry answers "nothing there" rather
 * than a placeholder, because half the surfaces above read a file to find out whether something EXISTS — an
 * acknowledgement, a staged document set, a run's result — and a fixture that answered every read would be
 * telling all of them yes. It says so the way the daemon does, in a 200 body: a demo whose console fills with
 * failed requests looks broken to the one audience that reads consoles. */
const workspaceRead = (path: string): Response => json(readFile(path));

// Only the screenshots an acceptance report embeds. `svg+xml` is a deliberate choice upstream (fixture/
// storefront.ts): a page of product UI as markup weighs a few kilobytes and stays sharp at any size.
const workspaceRaw = (path: string): Response => {
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

const memoryRead = (url: URL): Response => {
    const file = memoryFile(Date.now(), url.searchParams.get(`project`) ?? ``, url.searchParams.get(`name`) ?? ``);
    return file === undefined ? refuse(`No such memory note.`, 404) : json(file);
};

function memoryWrite({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        const { name, content } = body as { name?: string; content?: string };
        return okAfter(() => saveMemoryFile(Date.now(), name ?? ``, content ?? ``));
    });
}

function memoryForget({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => okAfter(() => deleteMemoryFile(Date.now(), (body as { name?: string }).name ?? ``)));
}

const knowledgeRead = (url: URL): Response => {
    const note = knowledgeNoteAt(url.searchParams.get(`path`) ?? ``);
    return note === undefined ? refuse(`No such note.`, 404) : json(note);
};

// Refuses exactly what the real backend refuses — a path that leaves the vault, or one that is not a note — so
// the demo's error state is the product's rather than an optimistic success.
function knowledgeWrite({ request }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        const { path, content } = body as { path?: string; content?: string };
        return saveKnowledgeNote(Date.now(), path ?? ``, content ?? ``)
            ? json({ ok: true })
            : refuse(`That is not a markdown note inside the vault.`, 400);
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

// The field's Aa switch, honoured here too: the browser's own tier matches case-sensitively the moment it is on,
// and a fixture that ignored it would answer the same query two different ways on one board.
const folded = (text: string, caseSensitive: boolean): string => (caseSensitive ? text : text.toLowerCase());

const searchAgents = (query: string, caseSensitive: boolean): AgentSearchResult => {
    const needle = folded(query.trim(), caseSensitive);
    const matches =
        needle === ``
            ? []
            : roster.agents.filter((agent) => folded(agent.title ?? ``, caseSensitive).includes(needle)).map((agent) => ({ id: agent.id }));
    return { matches, scanned: roster.agents.length };
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

/** How much of the real daemon this fixture stands in for — reported once at boot, so the gap is visible. */
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
    // Named rather than silent: the console line is how the next fixture route gets found.
    console.info(`[demo] no fixture route for ${request.method} ${url.pathname}`);
    return json({ error: `The demo fixture doesn't serve ${request.method} ${url.pathname}.` }, 404);
};
