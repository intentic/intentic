import {
    capabilitiesOf,
    DEFAULT_PRIVACY_SHIELD,
    type Info,
    PROVIDER_SPECS,
    type WorkflowRun,
} from "@intentic/sandbox-contract";
import { type FixtureRouter, refuse } from "@intentic/contract-serve";
import { BROWSER_SESSIONS, closeOwnBrowser, closeOwnTab, OWN_SESSION, openOwnBrowser, ownSession } from "../browser";
import { demoApprovals, removeDemoApproval, upsertDemoApproval } from "../fixture/approvals";
import {
    automationApprovals,
    automationCatalog,
    automationsList,
    checkDemoSource,
    deleteAutomation,
    resolveApproval,
    saveAutomation,
} from "../fixture/automations";
import { choresReport, writeLedger } from "../fixture/chores";
import { ciJobs, ciRunsResponse } from "../fixture/ci";
import { DESK_SANDBOX_NAME } from "../fixture/desk";
import { demoDevices, switchDemoPairings } from "../fixture/devices";
import { inProcessSubagents } from "../fixture/fleet";
import { demoHealth } from "../fixture/health";
import { demoLoops } from "../fixture/loops";
import { demoMetrics } from "../fixture/metrics";
import { demoNameDictionary } from "../fixture/nameDictionary";
import { answerDemoNeed, demoGrants, demoNeeds, provideDemoSecret, revokeDemoGrant } from "../fixture/needs";
import { demoRegistry } from "../fixture/registry";
import {
    demoCapabilities,
    demoExtensions,
    demoLocalModelFit,
    demoPanels,
    demoStartPrefetch,
    demoUsageRollup,
    setExtensionEnabled,
} from "../fixture/sandbox";
import { demoStorageCancel, demoStorageClean, demoStorageReport, demoStorageScan } from "../fixture/storage";
import { subagentTranscriptFor } from "../fixture/subagentTranscripts";
import { transcriptFor } from "../fixture/transcripts";
import { demoRuns, demoWorkflows } from "../fixture/workflows";
import {
    agentChanges,
    deleteEntry,
    fileDiff,
    gitChanges,
    PUBLISH_REFUSAL,
    readFile,
    REMOTE_REPOS,
    REPOS,
    restoreEntry,
    searchWorkspace,
    workspaceChildren,
    workspaceTree,
} from "../fixture/workspace";
import { demoMode, demoQuiet, deskEdition } from "../mode";
import { HANDOVER_TEXT, HANDOVER_TEXT_BEFORE } from "../fixture/document";
import { DEMO_CATALOGS, DEMO_CLAUDE_ACCOUNT, DEMO_CLAUDE_ACCOUNT_SECOND, DEMO_TRANSLATOR_ACCOUNTS } from "./accounts";
import { archiveAgents, assignAgent, keepWarmAgent, land, reactToAgent, searchAgents, searchSessions, setBreakPolicy, stopJob } from "./cards";
import { agentFlow, sandboxFlow } from "./devices";
import { events } from "./events";
import { demoAreas, demoPersonas, removeArea, saveArea, savePersona } from "./personas";
import { queueDoors, sayOrBook } from "./queue";
import { agentAnswer, amendAgent, boardAgents, broadcastRoster, heldApprovals, patchAgent, roster, STARTED_AT } from "./roster";
import { DEMO_REPO_CHECKS, DEMO_SAFETY_POLICY, DEMO_SAVINGS, DEMO_SETTINGS, DEMO_SYSTEM_PROMPT } from "./settings";
import { attach, reply, stopTurn } from "./turns";

// Every procedure the fixture serves, one answer per contract route; an empty-but-real area answers its contract's
// empty shape, not a 404.

/** A mutation with nothing to report: do it, then answer the daemon's own `{ ok: true }`. */
const okAfter = (write: () => void): { ok: true } => {
    write();
    return { ok: true };
};

// Filters runs to steps whose still-running agent is on this board's roster; a board missing an agent
// must not see the run it's a step of.
const runsOnBoard = (now: number): WorkflowRun[] =>
    demoRuns(now).filter((run) =>
        run.steps.every((step) => step.state !== `running` || roster.agents.some((agent) => agent.id === step.conversationId)),
    );

const info: Info = { name: deskEdition ? DESK_SANDBOX_NAME : `acme-shop`, version: `demo`, latest: `demo`, updateAvailable: false };

// The handshake `state` a routed sign-in issues; ConnectFlow only accepts a pasted address carrying this one.
const DEMO_CONNECT_STATE = `demo-connect-state`;

// One version of the document as the text a daemon's fileq would render from it (the diff's Text reading).
const derivedSide = (content: string) => ({ present: true as const, content, deriver: `docx v2`, notes: [], truncated: false });

const DEMO_COMMANDS = [
    { name: `plan`, description: `Think a change through before touching anything` },
    { name: `review`, description: `Review the working diff` },
    { name: `test`, description: `Run the affected tests`, hint: `[path]` },
];

// Every procedure the fixture serves; an empty-but-real area answers its contract's empty shape, not a 404.
export const procedures = {
    system: {
        events,
        info: () => info,
        session: () => ({ token: `demo-session`, expiresAt: Date.now() + 30 * 24 * 3_600_000, email: `ada@acme.dev` }),
        presence: () => ({ ok: true }),
        usage: () => ({ accounts: [] }),
        // Asked only while geek metrics are on (the status bar's gauges); it drifts per request, so the polling is visible.
        metrics: () => demoMetrics(Date.now(), roster.agents),
        // The Overview's Disk card: a scan already on hand, a rescan on request, and a clean that frees its category.
        storage: () => demoStorageReport(),
        scanStorage: () => demoStorageScan(),
        cancelStorageScan: () => demoStorageCancel(),
        cleanStorage: ({ category }) => demoStorageClean(category),
        terminals: () => ({
            sessions: [{ name: `agent-checkout-stripe`, label: `checkout-stripe`, kind: `agent`, running: true, activityAt: Date.now() }],
        }),
        // One still-driven browser session and one already closed, rendered as history, not a broken stream.
        // Quiet, the agent has put its browser down: the session is history, so the status bar has no open one to count.
        browsers: () => {
            const now = Date.now();
            const mine = ownSession(now);
            return {
                sessions: [
                    ...(mine === undefined ? [] : [mine]),
                    ...BROWSER_SESSIONS(now).map((session) =>
                        demoQuiet() && session.running ? { ...session, running: false, finishedAt: session.activityAt } : session,
                    ),
                ],
            };
        },
        // The visitor's own window opens for real (browser.ts): a tab per call, its picture drawn from the address.
        openBrowser: ({ url }) => openOwnBrowser(url),
        // The owner's own computers. Without this the Devices tab could only say it had nothing to show, so nothing
        // under a paired folder — the sync switches, and the two answers to a conflict — was ever drawn.
        devices: () => ({ devices: demoDevices(Date.now()) }),
        // The agent's own two verbs, streamed as the daemon streams them: progress lines, then the machine's sentence.
        // Each environment of a PC answers for itself, which is what a machine-wide update walks through — without this
        // the only state that page could show was the refusal of a route nobody serves.
        runDeviceAgentFlow: ({ id, op }) => agentFlow(id, op),
        // The container verbs and the unpair a removal ends with, answered the way a machine does, so a batch over
        // several rows can be pressed and watched rather than refused as a route nobody serves.
        manageDeviceSandbox: ({ slug, op }) => sandboxFlow(slug, op),
        runDeviceCommand: ({ id, command, sandboxId }) => {
            switchDemoPairings(id, command, sandboxId);
            return { ok: true, refused: false, message: `Ran ${command}${sandboxId === undefined ? `` : ` for ${sandboxId}`}.` };
        },
        closeBrowser: ({ name }) => {
            if (name !== OWN_SESSION) {
                return refuse(`This is the demo workspace: the browser you are watching is a recording, so there is nothing to close.`);
            }
            closeOwnBrowser();
            return { ok: true };
        },
        closeBrowserPage: ({ name, pageId }) => {
            if (name !== OWN_SESSION) {
                return refuse(`This is the demo workspace: the browser you are watching is a recording, so there is nothing to close.`);
            }
            closeOwnTab(pageId);
            return { ok: true };
        },
        // The demo has no desktop to show (its picture is not simulated, unserved.ts), and says so: no status bar chip
        // for it, and no claim that it is empty.
        desktop: () => ({ running: false }),
        subagents: () => ({ sessions: deskEdition || demoQuiet() ? [] : inProcessSubagents(STARTED_AT) }),
    },
    agents: {
        // `held` mirrors /automations/pending's approval queue, projected onto the board.
        list: () => ({ agents: boardAgents(), rev: roster.rev, held: heldApprovals() }),
        archived: () => ({ agents: [], rev: roster.rev, held: [] }),
        search: ({ query, caseSensitive }) => searchAgents(query, caseSensitive === true),
        seenAll: () => ({ agents: roster.agents, rev: roster.rev, held: heldApprovals() }),
        diff: ({ id }) => agentChanges(id),
        // A card that is not mid-turn reads its transcript instead of attaching.
        transcript: ({ id }) => transcriptFor(id),
        // The checkout agent's in-process subagents, read as transcripts of their own from its tray and its cards.
        subagentTranscript: ({ subagentId }) => subagentTranscriptFor(subagentId),
        systemPrompt: () => DEMO_SYSTEM_PROMPT,
        fileDiff: ({ repo, path }) => fileDiff(repo, path),
        rename: ({ id, title }) => agentAnswer(patchAgent(id, { title })),
        seen: ({ id }) => agentAnswer(patchAgent(id, { seenAt: Date.now() })),
        // As the daemon does: records since when a composer holds unsent words (the words stay in the tab), null clears it.
        unsent: ({ id, at }) => agentAnswer(amendAgent(id, ({ unsentAt: _cleared, ...card }) => (at === null ? card : { ...card, unsentAt: at }))),
        react: reactToAgent,
        assign: assignAgent,
        // As the registry does: `null` clears the conversation's own answer back to the sandbox's.
        autoLand: ({ id, autoLand }) =>
            agentAnswer(amendAgent(id, ({ autoLand: _held, ...card }) => (autoLand === null ? card : { ...card, autoLand }))),
        breakPolicy: setBreakPolicy,
        keepWarm: keepWarmAgent,
        stopJob,
        land: ({ id }) => land(id),
        discard: () => refuse(`This is the demo workspace: there is no worktree to discard.`),
        archive: archiveAgents,
        unarchive: () => ({ moved: [], rev: roster.rev }),
    },
    agent: {
        run: sayOrBook,
        ...queueDoors,
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
        delete: ({ path }) => deleteEntry(path),
        restore: ({ trashed }) => restoreEntry(trashed) ?? refuse(`That is no longer in the trash.`, 404),
        repos: () => ({ repos: [...REPOS] }),
        // The Health tab's report: hotspots and key modules for the shop's repositories (fixture/health.ts).
        health: ({ repo, since }) => demoHealth(repo, since, Date.now()),
        search: ({ query, mode, literal, word, caseSensitive, include = ``, dir = `` }) =>
            searchWorkspace(query, {
                smart: mode === `q`,
                literal: literal === true,
                word: word === true,
                caseSensitive: caseSensitive === true,
                include,
                dir,
            }),
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
        // Starts a provider-account sign-in (Cursor's, Grok's) in its device shape, so the connect view's card can be seen
        // holding one: a page to open, a code to copy, the wait for approval. Like the routed one below it never lands.
        start: ({ provider, variant }) => ({
            url: `https://example.com/demo-sign-in?provider=${provider}`,
            code: `DEMO-4821`,
            state: ``,
            flow: `device`,
            variant: variant ?? ``,
            handshake: `demo-handshake-${provider}`,
            expiresAt: Date.now() + 15 * 60 * 1000,
        }),
        status: () => ({ status: `wait` }),
        cancel: () => ({ ok: true }),
    },
    translator: {
        // Codex authenticates only through the translator, not an oauth account.
        accounts: () => DEMO_TRANSLATOR_ACCOUNTS,
        // Starts a routed sign-in so ConnectFlow is reachable here: without it the panel a new user meets first
        // could only be seen against a real daemon. `redirect` is the shape Google uses (a loopback dead-end).
        connect: ({ provider }) => ({
            url: `https://accounts.google.com/o/oauth2/auth?demo=${provider}`,
            code: ``,
            state: DEMO_CONNECT_STATE,
            flow: `redirect`,
        }),
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
        // What the connect view's local lane draws: a 32 GB laptop with nothing downloaded yet.
        localModelFit: () => demoLocalModelFit(),
        // Nothing is really fetched here; the press flips the fixture so the lane draws the state it has the most to say
        // about — a transfer under way, with the Stop that declines it.
        localModelPrefetch: ({ action }) => demoStartPrefetch(action === `start`),
        // Ollama on the laptop, serving two models and not yet pointed at: the row the panel has the most to say about.
        hostServers: () => ({
            servers: [{ kind: `ollama`, label: `Ollama`, baseUrl: `http://host.docker.internal:11434/v1`, models: [`qwen3:32b`, `llama3.2:latest`] }],
        }),
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
    // A fresh sandbox's shield: off, nothing learned, no reader installed, and this catalog's providers to trust. Its
    // writes refuse: it guards a sandbox's own model traffic, and a recording sends none.
    privacy: {
        status: () => ({
            policy: DEFAULT_PRIVACY_SHIELD,
            known: 0,
            tokens: 0,
            readers: { ocr: false, model: false },
            providers: PROVIDER_SPECS.map((spec) => ({
                id: spec.id,
                label: spec.label,
                shieldable: capabilitiesOf(spec.id, `native`).privacy === `gateway` || capabilitiesOf(spec.id, `claude-code`).privacy === `gateway`,
                local: false,
            })),
        }),
        setPolicy: () => refuse(`This is the demo workspace: the privacy shield guards a sandbox's own model traffic, and this one sends none.`),
        log: () => [],
        // Nothing is logged, so there is no token to read back.
        reveal: () => ({}),
        dictionary: ({ query }) => demoNameDictionary(query),
        sources: () => [],
        forget: () => refuse(`This is the demo workspace: nothing has been taught to its privacy shield.`),
    },
    vpn: {
        list: () => ({ links: [] }),
    },
    // The kinds a fresh sandbox sorts heavy work into, so "Where heavy work runs" draws its rows; nothing ever ran on a
    // runner in a recording, and sending a command to one needs a machine this demo does not have.
    offload: {
        kinds: () => ({
            kinds: [
                { id: `repo-verify`, pattern: `\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?verify(:\\S+)?\\b` },
                { id: `typechecker`, pattern: `(?<![-.])\\b(tsc|tsgo|vue-tsc)\\b(?![-.])` },
                { id: `package-script`, pattern: `\\b(pnpm|npm|yarn|bun)\\b[^&|;]*\\b(test|typecheck|verify|check|build)\\b` },
            ],
        }),
        runs: () => ({ runs: [] }),
    },
    // CI board data is real; the badge reflects the fixture's own state. Rerun, cancel and Fix-with-agent
    // refuse: a recording can't act on a real pipeline. Main is failing, with its fix agents, only in the whole recording,
    // the one roster that carries them.
    ci: {
        runs: () => ciRunsResponse(Date.now(), { mainFailing: demoMode.id === `full`, green: demoQuiet() }),
        jobs: ({ repo, runId }) => ({ jobs: ciJobs(repo, runId, Date.now(), demoQuiet()) }),
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
        // A source's check, answered from the fixture: the demo reaches no registry, GitHub or page.
        check: ({ source }) => checkDemoSource(source),
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
        rollup: () => ({
            rows: demoUsageRollup(
                STARTED_AT,
                (model) => roster.agents.find((agent) => agent.startedBy?.startsWith(`agent:`) !== true && agent.model === model)?.id,
            ),
        }),
        // What every connection read posts, on arrival and on the rail's refresh control alike. Nothing held: every demo
        // reading is taken, so the press moves the age rather than explaining why it couldn't.
        refreshPlanLimits: () => ({ ok: true, held: [] }),
    },
    secrets: {
        inventory: () => ({ entries: [] }),
    },
    // What the agents wait on people for, answered for real against the fixture store (docs/architecture/needs.md).
    needs: {
        list: ({ conversationId, open }) => ({
            needs: demoNeeds().filter(
                (need) =>
                    (conversationId === undefined || need.conversationId === conversationId) &&
                    (open !== true || need.status === `open` || need.status === `working`),
            ),
        }),
        answer: ({ id, answer }) => {
            const need = answerDemoNeed(id, answer);
            broadcastRoster();
            return need;
        },
        provideSecret: ({ id }) => {
            const need = provideDemoSecret(id);
            broadcastRoster();
            return need;
        },
        grants: () => demoGrants(),
        revokeGrant: (grant) => {
            revokeDemoGrant(grant);
            return { ok: true };
        },
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
        list: () => ({ approvals: [...demoApprovals()], invalid: [] }),
        upsert: (item) => okAfter(() => upsertDemoApproval(item)),
        remove: ({ id }) => okAfter(() => removeDemoApproval(id)),
        // The demo's Claude settings declare no hooks, so no turn ever held one for approval.
        hookRequests: () => ({ requests: [] }),
    },
} satisfies FixtureRouter;
