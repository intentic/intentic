import {
    type AgentSearchResult,
    type AgentsList,
    type AgentSummary,
    AgentReplySchema,
    type Automation,
    type BrowsersList,
    type CiJobsResponse,
    type CiSeenResponse,
    type Info,
    type Model,
    type OauthAccount,
    type OauthAccountList,
    SANDBOX_ROUTE_NAMES,
    type SavingsReport,
    type SystemEvent,
    type TerminalsList,
    type TranslatorAccounts,
} from "@intentic/sandbox-contract";
import { BROWSER_SESSIONS } from "./browser";
import { automationApprovals, automationsList, deleteAutomation, resolveApproval, saveAutomation } from "./fixture/automations";
import { ciJobs, ciRunsResponse } from "./fixture/ci";
import { AWAITING_AGENT_ID, FEATURED_AGENT_ID, fleetRoster } from "./fixture/fleet";
import { deleteMemoryFile, memoryFile, memoryList, saveMemoryFile } from "./fixture/memory";
import { demoCapabilities, demoEnvironment, demoExtensions, demoUsageRollup, setExtensionEnabled } from "./fixture/sandbox";
import {
    agentChanges,
    fileBody,
    fileDiff,
    gitChanges,
    landAgentDelta,
    landedPaths,
    REPOS,
    searchWorkspace,
    sessions,
    workspaceTree,
} from "./fixture/workspace";
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

// The roster is live state: rename/archive/seen write it, and every write bumps `rev` and re-broadcasts, which
// is exactly the contract the real registry has with the board (snapshot-not-diff, newest rev wins).
const roster = { agents: fleetRoster(STARTED_AT), rev: 1 };
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

/* The /events stream: the hello identity frame, then a heartbeat inside the browser's 10s watchdog, plus the
 * roster and the presence of a second member — which is the whole sharing story told in one frame.
 *
 * `routes` is deliberately omitted from the hello. useDaemonRoutes reads its absence as "assume supported", so
 * no feature gates itself off on a daemon that never advertised — and the fixture doesn't have to keep a list
 * of route names in step with the contract. (SANDBOX_ROUTE_NAMES is imported only for the `info` build string,
 * so the count in the UI is honest about how much surface this fixture stands in for.) */
const HEARTBEAT_MS = 2_000;

const events = (request: Request): Response =>
    eventStream(request, (sink) => {
        const listener = (event: SystemEvent): void => sink.emit(event);
        listeners.add(listener);

        sink.emit({ kind: `hello`, workspaceId: `demo-workspace`, build: `demo`, boot: { ready: true, startedAt: STARTED_AT, steps: [] } });
        sink.emit({ kind: `agents`, agents: roster.agents, rev: roster.rev });
        sink.emit({ kind: `reposChanged`, repos: [...REPOS] });
        sink.emit({
            kind: `presence`,
            users: [
                { clientId: `demo-owner`, email: `ada@acme.dev`, name: `Ada Lovelace`, idle: false, view: `workspace` },
                { clientId: `demo-mate`, email: `grace@acme.dev`, name: `Grace Hopper`, idle: true, view: `agents` },
            ],
        });

        const beat = setInterval(() => sink.emit({ kind: `heartbeat` }), HEARTBEAT_MS);
        return () => {
            clearInterval(beat);
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

const startTurn = async (request: Request): Promise<Response> => {
    const body = (await request.json()) as { conversationId?: string; prompt?: string };
    const conversationId = body.conversationId ?? FEATURED_AGENT_ID;
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
    patchAgent(AWAITING_AGENT_ID, { attention: { plan: false, question: false, permission: false, conflict: false } });
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
        patchAgent(id, { status: `conflict`, updatedAt: Date.now(), attention: { plan: false, question: false, permission: false, conflict: true } });
        return json(result);
    }
    patchAgent(id, { status: `landed`, updatedAt: Date.now(), attention: { plan: false, question: false, permission: false, conflict: false } });
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
    [`DELETE`, `/system/browsers/{name}`, () => refuse(`This is the demo workspace — the browser you are watching is a recording, so there is nothing to close.`)],
    [`GET`, `/system/subagents`, () => json({ subagents: [] })],

    [`GET`, `/agents`, () => json({ agents: roster.agents, rev: roster.rev } satisfies AgentsList)],
    [`GET`, `/agents/archived`, () => json({ agents: [], rev: roster.rev } satisfies AgentsList)],
    [`GET`, `/agents/search`, ({ url }) => json(searchAgents(url.searchParams.get(`query`) ?? ``))],
    [`POST`, `/agents/seen`, () => json({ agents: roster.agents, rev: roster.rev } satisfies AgentsList)],
    [`GET`, `/agents/{id}/diff`, ({ param }) => json(agentChanges(param(`id`)))],
    [`GET`, `/agents/{id}/transcript`, () => json({ messages: [] })],
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

    [`GET`, `/sessions`, ({ url }) => json({ sessions: searchSessions(url.searchParams.get(`query`) ?? ``) })],
    [`GET`, `/sessions/{id}`, () => json({ messages: [] })],

    [`GET`, `/workspace/tree`, () => json(workspaceTree())],
    [`GET`, `/workspace/children`, () => json({ entries: [], hidden: 0 })],
    [`GET`, `/workspace/file`, ({ url }) => json(workspaceFile(url.searchParams.get(`path`) ?? ``))],
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
    [`GET`, `/claude/models`, () => json({ models: CLAUDE_MODELS, default: `claude-sonnet-5` })],
    [`GET`, `/codex/models`, () => json({ models: CODEX_MODELS, default: `gpt-5.2-codex` })],
    [`GET`, `/grok/models`, () => json({ models: [], default: `` })],
    [`GET`, `/kimi/models`, () => json({ models: [], default: `` })],
    [`GET`, `/gemini/models`, () => json({ models: [], default: `` })],

    [`GET`, `/settings`, () => json(DEMO_SETTINGS)],
    [`GET`, `/settings/savings`, () => json(DEMO_SAVINGS)],
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
    [`POST`, `/ci/fix`, () => refuse(`This is the demo workspace — a fix agent needs your repo and its CI logs. Start a sandbox and this button opens one.`)],

    [`GET`, `/chores`, () => json({ chores: [] })],

    /* Automations — the sandbox working while nobody watches. Enabling, editing and deleting a row are real
     * (the fixture is the store), and so is clearing a held wake; what refuses is FIRING one, because a wake is
     * an agent turn against a repo the recording doesn't have. */
    [`GET`, `/automations`, () => json({ automations: automationsList(Date.now()) })],
    [`GET`, `/automations/pending`, () => json({ approvals: automationApprovals(Date.now()) })],
    [`POST`, `/automations`, saveAutomationRoute],
    [`DELETE`, `/automations/{id}`, ({ param }) => okAfter(() => deleteAutomation(Date.now(), param(`id`)))],
    [`POST`, `/automations/{id}/run`, () => refuse(`This is the demo workspace — firing an automation runs a real turn against real systems.`)],
    [`POST`, `/automations/pending/{id}/approve`, () => refuse(`This is the demo workspace — approving a held wake would start the turn it is holding.`)],
    [`POST`, `/automations/pending/{id}/reject`, ({ param }) => okAfter(() => resolveApproval(Date.now(), param(`id`)))],

    /* Memory: what the agent carries between sessions, readable and — the point of the surface — editable. The
     * red pen writes into the fixture, so an edit and a forget both hold until the tab is reloaded. */
    [`GET`, `/memory`, () => json({ files: memoryList(Date.now()) })],
    [`GET`, `/memory/file`, ({ url }) => memoryRead(url)],
    [`PUT`, `/memory/file`, memoryWrite],
    [`DELETE`, `/memory/file`, memoryForget],
    [`GET`, `/capabilities`, () => json({ capabilities: demoCapabilities() })],
    [`GET`, `/usage/rollup`, () => json({ rows: demoUsageRollup(STARTED_AT) })],
    [`GET`, `/secrets/inventory`, () => json({ secrets: [] })],
    [`GET`, `/ports`, () => json({ ports: [] })],
    [`GET`, `/panels`, () => json({ panels: [] })],
    [`GET`, `/extensions`, () => json({ extensions: demoExtensions() })],
    [`POST`, `/extensions/{id}/enabled`, setEnabled],
    [`GET`, `/drafts`, () => json({ drafts: [] })],
    [`GET`, `/members`, () => json({ members: [] })],
    [`GET`, `/environment`, () => json(demoEnvironment())],
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

// The sandbox-wide agent settings the chat and the hub read. autoLand off is what puts a finished agent in
// "Ready to land" — the state the demo's review panel exists to show.
const DEMO_SETTINGS = { autoLand: false, systemPromptMode: `intentic`, stableSystemPrompt: true, skills: [] };

// What the tool-output cleaners were worth over the window the hub is showing. A measured claim, so the demo
// states it the way the product does: per-stage, with the ledger's own freshness.
const DEMO_SAVINGS: SavingsReport = {
    input: {
        source: `native`,
        windowed: true,
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
            { command: `pnpm -C web build`, tokens: 41_200 },
            { command: `docker compose logs api`, tokens: 28_900 },
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

function setEnabled({ request, param }: RouteContext): Promise<Response> {
    return request.json().then((body) => {
        setExtensionEnabled(param(`id`), (body as { enabled?: boolean }).enabled === true);
        return json({ extensions: demoExtensions() });
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

const searchAgents = (query: string): AgentSearchResult => {
    const needle = query.trim().toLowerCase();
    const matches =
        needle === `` ? [] : roster.agents.filter((agent) => (agent.title ?? ``).toLowerCase().includes(needle)).map((agent) => ({ id: agent.id }));
    return { matches, scanned: roster.agents.length };
};

const searchSessions = (query: string): ReturnType<typeof sessions> => {
    const all = sessions(Date.now());
    const needle = query.trim().toLowerCase();
    return needle === `` ? all : all.filter((session) => session.title.toLowerCase().includes(needle));
};

const workspaceFile = (path: string): { path: string; content: string; size: number; offset: number; bytes: number } => {
    const content = fileBody(path);
    return { path, content, size: content.length, offset: 0, bytes: content.length };
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
