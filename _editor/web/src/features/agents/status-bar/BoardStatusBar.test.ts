import "@intentic/testing/dom";
import { type Finding, type MainlineProject, type MainlinePush, type MainlineRun, type MainlineStatus, pushFixBase, type Red, type SandboxMetrics } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import type { PushFixAttempt } from "../mainline/useMainline";

const opened = jest.fn((_conversationId: string, _title?: string) => undefined);
const watched = jest.fn((_session: string) => undefined);
// The owner's hands on what a push left: each answers as the daemon would, and the suite reads what it was asked.
const dismissed = jest.fn(async (_project: string, ids?: readonly string[], _restore?: boolean) => ids?.length ?? 0);
const rechecked = jest.fn(async (_project: string) => ({ measured: true, resolved: 2, open: 5 }));
const handed = jest.fn(async (_project: string, _pick?: unknown, _mode?: unknown) => `push-fix-intentic-0abc123`);
// The hand-over's live attempt as the roster would report it; none unless a test puts one there.
const attemptOnIt = ref<PushFixAttempt | undefined>(undefined);

// The seam's dragging is the kit's own suite; here only what the status bar draws and when. The run button is its own
// suite's too: here it is a button that says its label and runs on a press.
jest.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    return {
        ResizeSeam: vue.defineComponent({ setup: () => () => vue.h(`div`, { role: `separator` }) }),
        Meter: vue.defineComponent({ setup: () => () => vue.h(`div`, { "data-meter": `` }) }),
        Notice: vue.defineComponent({ setup: (_props, { slots }) => () => vue.h(`div`, { role: `status` }, slots[`default`]?.()) }),
        AgentRunButton: vue.defineComponent({
            props: { label: { type: String, required: true } },
            emits: [`run`],
            setup: (props, { emit }) => () => vue.h(`button`, { type: `button`, "data-run": ``, onClick: () => emit(`run`) }, props.label),
        }),
        fixStanceLook: () => ({ icon: `spinner`, spin: true, ink: `text-info`, chip: `` }),
        useAgentRunPick: () => ({
            model: vue.computed(() => ({ provider: `claude`, model: `opus`, label: `Opus` })),
            overridden: vue.computed(() => false),
            resume: vue.computed(() => undefined),
            choose: async () => false,
            clear: () => undefined,
        }),
        ui: {
            iconButton: (extra: string) => extra,
            linkButton: (extra: string) => extra,
            textAction: (extra: string) => extra,
            sectionLabelSm: (extra: string) => extra,
        },
    };
});
jest.mock("../mainline/useMainline", () => ({
    dismissPushFindings: dismissed,
    recheckPushFindings: rechecked,
    handPushFindings: handed,
    usePushFixAttempt: () => computed(() => attemptOnIt.value),
}));
jest.mock("../../chat/models/shellModelPicking", () => ({ shellModelPicking: () => ({}) }));
jest.mock("../fleet/useAgents", () => ({
    useAgents: () => ({ agentById: (id: string) => (id === `land-fix-web-abc` ? { title: `Fix main after "Release notes"` } : undefined) }),
}));
jest.mock("../mainline/openLanded", () => ({
    openLandConversation: opened,
    useLandTitle: () => (conversationId: string, title?: string) =>
        title ?? (conversationId === `land-fix-web-abc` ? `Fix main after "Release notes"` : conversationId),
}));
jest.mock("../../terminal/useWorkTerminals", () => ({ openWorkTerminal: watched }));

const { default: BoardStatusBar } = await import("./BoardStatusBar.vue");
const { openPanel, panelHeight } = await import("./statusBarState");
const { sinceWhen } = await import("../mainline/mainlineView");
const { showLiveMetrics } = await import("../metrics/liveMetrics");
const { useNotifications } = await import("../../../shell/notifications/notifications");
const { SandboxHttpError } = await import("../../sandbox/client/sandboxHttpError");

const NOW = 10_000_000_000;
const MINUTE = 60_000;
const GIB = 2 ** 30;

let app: App | undefined;

interface Mounted {
    readonly element: HTMLElement;
}

// The bar's memory is the window's (two preferences), so a case that starts with a panel open sets it there.
const mount = (mainline: MainlineStatus | undefined, options: { metrics?: SandboxMetrics; open?: `mainline` | `metrics`; router?: boolean } = {}): Mounted => {
    openPanel.value = options.open;
    panelHeight.value = 240;
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () => h(BoardStatusBar, { mainline, metrics: options.metrics }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    // Only the older sandbox's note links anywhere (to the sandbox page's Update card).
    if (options.router === true) {
        app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: { render: () => null } }] }));
    }
    app.mount(element);
    return { element };
};

// An element's text pieces joined by a space, as they read; the compiled template keeps no whitespace between them.
const wordsOf = (node: Node | null | undefined): string =>
    node === null || node === undefined
        ? ``
        : [...node.childNodes]
              .map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? ``) : wordsOf(child)).trim())
              .filter((piece) => piece !== ``)
              .join(` `);

const segment = (element: HTMLElement, id = `mainline`): HTMLButtonElement => element.querySelector<HTMLButtonElement>(`[data-segment="${id}"]`)!;
const panel = (element: HTMLElement, id = `mainline`): HTMLElement | null => element.querySelector<HTMLElement>(`[data-panel="${id}"]`);

const green = (over: Partial<MainlineRun> = {}): MainlineRun => ({
    project: `web`,
    command: `pnpm verify`,
    status: `green`,
    startedAt: NOW - 14 * MINUTE,
    at: NOW - 12 * MINUTE,
    lands: [{ conversationId: `checkout`, title: `Add Stripe checkout`, at: NOW - 15 * MINUTE }],
    failures: [],
    failureCount: 0,
    attempt: 0,
    ...over,
});

const RED: MainlineRun = {
    ...green(),
    status: `red`,
    at: NOW - 31 * MINUTE,
    lands: [{ conversationId: `notes`, title: `Release notes`, at: NOW - 34 * MINUTE }],
    failures: [`web/src/pages/changelog.test.ts › lists every release`, `web/src/pages/changelog.test.ts › links each tag`],
    units: [
        { name: `lists every release`, path: `web/src/pages/changelog.test.ts` },
        { name: `links each tag`, path: `web/src/pages/changelog.test.ts` },
    ],
    failureCount: 2,
    attempt: 1,
    suspects: [`notes`],
    named: true,
    routing: { kind: `fix-up`, conversationId: `land-fix-web-abc`, at: NOW - 30 * MINUTE, detail: `Its conversation had gone cold.` },
};

// A red project as a current daemon lays it: at the run's suspects, with its latest decision, and its check's terminal.
const redProject = (run: MainlineRun, over: Partial<MainlineProject> = {}): MainlineProject => {
    const red: NonNullable<MainlineProject[`red`]> = {
        since: run.at,
        cause: run.lands.filter((each) => run.suspects?.includes(each.conversationId) === true).map(({ conversationId, title }) => ({ conversationId, title })),
        named: true,
    };
    if (run.routing !== undefined) {
        red.fixer = run.routing;
    }
    return { project: run.project, queued: [], session: `panel-${run.project}--verify`, last: run, redSince: run.at, red, ...over };
};

const redStatus = (): MainlineStatus => ({
    projects: [redProject(RED, { queued: [{ conversationId: `checkout`, title: `Add Stripe checkout`, at: NOW - 40_000 }] })],
    recent: [RED, green({ at: NOW - 90 * MINUTE })],
    reds: [],
});

const runningStatus = (): MainlineStatus => ({
    projects: [
        {
            project: `web`,
            running: {
                command: `pnpm verify`,
                startedAt: NOW - 65_000,
                lands: [
                    { conversationId: `checkout`, title: `Add Stripe checkout`, at: NOW - 70_000 },
                    { conversationId: `copy`, title: `Tighten the pricing copy`, at: NOW - 69_000 },
                ],
            },
            queued: [],
            session: `panel-web--verify`,
            last: green(),
        },
    ],
    recent: [green()],
    reds: [],
});

const metrics = (): SandboxMetrics => ({
    at: 1,
    windowMs: 3_000,
    sandbox: {
        cpuPercent: 23.4,
        cores: 16,
        memoryBytes: 5.5 * GIB,
        memoryLimitBytes: 16 * GIB,
        swapBytes: 0,
        diskBytes: 400 * GIB,
        diskTotalBytes: 1_000 * GIB,
        loadAverage: [1.5, 1.25, 1],
        processes: 104,
    },
    daemon: { rssBytes: 0.4 * GIB, heapUsedBytes: 0.1 * GIB },
    sessions: {},
    roles: {},
});

// What the real case left: two commits pushed to main, seven findings, the tree's own breakage among them.
const leftFinding = (id: string, check: string, gate: `code` | `tidy`, text: string): Finding => ({
    id,
    source: check,
    recheckable: true,
    gate,
    text,
    command: `node _tools/checks/run.mjs --only ${check}`,
});

const LEFT: Finding[] = [
    leftFinding(`paths-1`, `paths`, `tidy`, `_sandbox/sandbox/src/workspace/files/workspace-trash.integration.test.ts:8  spells the state dir`),
    leftFinding(`silent-1`, `silent-catch`, `tidy`, `_sandbox/sandbox/src/workspace/files/workspace-trash.ts:127  .catch discards the error`),
    leftFinding(`silent-2`, `silent-catch`, `code`, `_sandbox/sandbox/src/workspace/files/workspace-trash.ts: 3 silent catch(es), the baseline allows 0`),
    leftFinding(`layout-1`, `layout`, `code`, `_editor/web/src/features/workspace/explorer: 36 files, the baseline allows 33`),
    leftFinding(`layout-2`, `layout`, `code`, `_sandbox/sandbox/src/workspace/files: 32 files`),
    leftFinding(`daemon-1`, `daemon-boundaries`, `code`, `portability -> settings closes a cycle`),
    leftFinding(`buttons-1`, `buttons`, `tidy`, `_editor/web/src/features/agents/metrics/SandboxMetricsDetails.vue:29  a bare <button>`),
];

const PUSHED: MainlinePush = {
    project: `intentic`,
    id: `push-725e054`,
    at: NOW - 20 * MINUTE,
    remote: `origin`,
    branch: `main`,
    base: `6c6a13a392`,
    head: `725e054fb6`,
    commits: 2,
    findings: LEFT,
};

const CLEAN_PUSH: MainlinePush = { ...PUSHED, id: `push-6c6a13a`, at: NOW - 300 * MINUTE, head: `6c6a13a392`, commits: 1, findings: [] };

// What the project owes of it: everything the push found.
const LEFT_RED: Red = { source: `push`, scope: `intentic`, since: PUSHED.at, findings: LEFT, suspects: [], named: false, decisions: [] };

const pushedStatus = (): MainlineStatus => ({
    projects: [{ project: `web`, queued: [], last: green() }],
    recent: [green()],
    pushed: [PUSHED, CLEAN_PUSH],
    reds: [LEFT_RED],
});

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    opened.mockClear();
    watched.mockClear();
    dismissed.mockClear();
    rechecked.mockClear();
    handed.mockClear();
    attemptOnIt.value = undefined;
    useNotifications().dismissReceipt();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    jest.useRealTimers();
});

describe(`the main line, at rest`, () => {
    it(`draws nothing while no land has been checked, or while the daemon does not say`, () => {
        expect(mount(undefined).element.querySelector(`[role="region"]`)).toBeNull();
        app?.unmount();
        expect(mount({ projects: [], recent: [], reds: [] }).element.querySelector(`[role="region"]`)).toBeNull();
    });

    it(`sits in the status bar, not over the board: no panel until the reader opens one`, () => {
        const { element } = mount(redStatus());
        expect(element.querySelector(`[role="region"]`)?.getAttribute(`aria-label`)).toBe(`Board status`);
        expect(segment(element).getAttribute(`aria-expanded`)).toBe(`false`);
        expect(element.querySelector(`[data-panel]`)).toBeNull();
    });

    // Health and activity side by side; what the check runs and whose work it measures are the panel's to say.
    it(`says whether main passes and what the check is doing, in two short answers`, async () => {
        const { element } = mount(runningStatus());
        expect(wordsOf(segment(element))).toBe(`Main passing Checking web 1m 5s`);
        expect(wordsOf(segment(element).querySelector(`[data-item="health"]`))).toBe(`Main passing`);
        expect(wordsOf(segment(element).querySelector(`[data-item="running"]`))).toBe(`Checking web 1m 5s`);
        expect(segment(element).textContent).not.toContain(`pnpm verify`);
        expect(segment(element).textContent).not.toContain(`Add Stripe checkout`);

        jest.advanceTimersByTime(1_000);
        await nextTick();
        expect(wordsOf(segment(element).querySelector(`[data-item="running"]`))).toBe(`Checking web 1m 6s`);
    });

    it(`says which project fails and who has it, with nothing to press beside it`, () => {
        const { element } = mount(redStatus());
        expect(wordsOf(segment(element))).toBe(`web failing · fixing 1 queued`);
        expect(wordsOf(segment(element).querySelector(`[data-item="health"]`))).toBe(`web failing · fixing`);
        expect(wordsOf(segment(element).querySelector(`[data-item="queued"]`))).toBe(`1 queued`);
        // The bar is its toggles and nothing else: who has the red is one press away, in the panel.
        expect([...element.querySelectorAll<HTMLButtonElement>(`button`)].map((button) => button.dataset[`segment`])).toEqual([`mainline`]);
        expect(element.querySelector(`[data-routing]`)).toBeNull();
    });

    it(`asks for the reader's eye only when a red waits for them`, () => {
        const spent: MainlineRun = { ...RED, routing: { kind: `spent`, at: NOW - 5 * MINUTE, detail: `Still red after 2 fresh attempt(s); it waits for you.` } };
        const { element } = mount({ projects: [redProject(spent)], recent: [spent], reds: [] });
        const health = segment(element).querySelector(`[data-item="health"]`)!;
        expect(wordsOf(health)).toBe(`web failing · needs you`);
        expect(health.querySelector(`.text-warning`)?.textContent?.trim()).toBe(`· needs you`);
        app?.unmount();

        const { element: fixing } = mount(redStatus());
        expect(segment(fixing).querySelector(`.text-warning`)).toBeNull();
    });

    it(`counts the projects failing when there is more than one, and keeps a red on the line while another check runs`, () => {
        const apiRed: MainlineRun = { ...RED, project: `api`, at: NOW - 20 * MINUTE, routing: undefined };
        const status = redStatus();
        const { element } = mount({
            projects: [
                ...status.projects,
                redProject(apiRed, { running: { command: `pnpm test`, startedAt: NOW - 5_000, lands: [] } }),
            ],
            recent: [apiRed, ...status.recent],
            reds: [],
        });
        expect(wordsOf(segment(element))).toBe(`2 projects failing Checking api 5s 1 queued`);
    });

    it(`says main passes once something was checked, and nothing about health before`, () => {
        const { element } = mount({ projects: [{ project: `web`, queued: [], last: green() }], recent: [green()], reds: [] });
        expect(wordsOf(segment(element))).toBe(`Main passing`);
        app?.unmount();

        const first = mount({ projects: [{ project: `web`, running: { command: `pnpm verify`, startedAt: NOW - 5_000, lands: [] }, queued: [] }], recent: [], reds: [] });
        expect(wordsOf(segment(first.element))).toBe(`Checking web 5s`);
        expect(first.element.querySelector(`[data-item="health"]`)).toBeNull();
    });

    it(`counts the lands queued for the next check, each once`, () => {
        const waiting = { conversationId: `a`, at: NOW - 5_000 };
        const { element } = mount({
            projects: [
                { project: `web`, queued: [waiting, { conversationId: `b`, at: NOW - 3_000 }], last: green() },
                // The same land waiting in a second project is still one land.
                { project: `api`, queued: [waiting] },
            ],
            recent: [green()],
            reds: [],
        });
        expect(wordsOf(segment(element))).toBe(`Main passing 2 queued`);
    });

    it(`counts what pushes left in amber beside main passing, which it never takes off the bar`, () => {
        const { element } = mount(pushedStatus());
        expect(wordsOf(segment(element))).toBe(`Main passing 7 left at push`);
        expect(segment(element).querySelector(`[data-item="push"]`)?.className).toBe(`flex shrink-0 items-center gap-1.5 text-warning`);
    });
});

describe(`the main line's panel`, () => {
    const sections = (element: HTMLElement): string[] =>
        [...panel(element)!.querySelectorAll<HTMLElement>(`[data-section]`)].map((section) => section.dataset[`section`] ?? ``);
    const section = (element: HTMLElement, id: string): HTMLElement => panel(element)!.querySelector<HTMLElement>(`[data-section="${id}"]`)!;
    const buttonNamed = (within: HTMLElement, words: string): HTMLButtonElement =>
        [...within.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => wordsOf(button) === words)!;

    it(`opens above the bar onto the road a land travels: queued, checking, result, then the record`, async () => {
        const { element } = mount(redStatus());
        segment(element).click();
        await nextTick();

        expect(openPanel.value).toBe(`mainline`);
        expect(segment(element).getAttribute(`aria-expanded`)).toBe(`true`);
        const docked = panel(element)!;
        expect(segment(element).getAttribute(`aria-controls`)).toBe(docked.id);
        // Nothing in it is explained on hover: the panel's header carries no note.
        expect(docked.querySelector(`[role="note"]`)).toBeNull();
        expect(sections(element)).toEqual([`queued`, `checking`, `result`, `history`]);
        expect(wordsOf(section(element, `queued`).querySelector(`h4`))).toBe(`Queued 1`);
        expect(wordsOf(section(element, `queued`).querySelector(`button`))).toBe(`Add Stripe checkout`);
        expect(wordsOf(section(element, `checking`))).toBe(`Checking Idle`);
        expect(wordsOf(section(element, `history`))).toBe(`History failed Release notes 30m ago passed Add Stripe checkout 1h ago`);
    });

    it(`says of a failing project who has it, what it is laid at, then what failed, test names first`, () => {
        const { element } = mount(redStatus(), { open: `mainline` });
        const web = section(element, `result`).querySelector<HTMLElement>(`[data-result="web"]`)!;
        expect(wordsOf(web.firstElementChild)).toBe(`web failing since ${sinceWhen(RED.at)} Logs`);
        expect(wordsOf(web.querySelector(`[data-fix]`))).toBe(`Being fixed in Fix main after "Release notes"`);
        expect(wordsOf(web.querySelector(`[data-cause]`))).toBe(`Likely cause Release notes`);
        expect([...web.querySelectorAll(`[data-failures] li`)].map((item) => wordsOf(item))).toEqual([
            `lists every release changelog.test.ts`,
            `links each tag changelog.test.ts`,
        ]);
        // Why it went to a fresh conversation is the sandbox's business: nothing the reader has to act on.
        expect(web.textContent).not.toContain(`Its conversation had gone cold.`);
        expect(web.querySelector(`[data-fix]`)?.classList.contains(`text-muted`)).toBe(true);
    });

    it(`lists every land the running check measures, and says a project with nothing failing passes`, () => {
        const { element } = mount(runningStatus(), { open: `mainline` });
        expect(wordsOf(section(element, `queued`))).toBe(`Queued Nothing queued`);
        expect(wordsOf(section(element, `checking`))).toBe(`Checking web 1m 5s Logs Add Stripe checkout Tighten the pricing copy`);
        expect(wordsOf(section(element, `result`))).toBe(`Result web passing 11m ago`);
    });

    it(`gives a red one line on who has it, in the words a reader acts on`, () => {
        const redWith = (routing: MainlineRun[`routing`]): MainlineStatus => {
            const run: MainlineRun = { ...RED, routing };
            return { projects: [redProject(run)], recent: [run], reds: [] };
        };
        interface FixLine {
            readonly words: string;
            readonly tone: string;
            readonly detail: string;
        }
        const lineOf = (routing: MainlineRun[`routing`]): FixLine => {
            const { element } = mount(redWith(routing), { open: `mainline` });
            const web = section(element, `result`).querySelector<HTMLElement>(`[data-result="web"]`)!;
            const fix = web.querySelector<HTMLElement>(`[data-fix]`)!;
            const line: FixLine = { words: wordsOf(fix), tone: [`text-muted`, `text-warning`, `text-success`].find((ink) => fix.classList.contains(ink)) ?? ``, detail: wordsOf(fix.nextElementSibling?.tagName === `P` ? fix.nextElementSibling : null) };
            app?.unmount();
            app = undefined;
            document.body.innerHTML = ``;
            return line;
        };
        const at = NOW - 5 * MINUTE;
        expect(lineOf({ kind: `held`, conversationId: `land-fix-web-abc`, at })).toEqual({ words: `Waiting for Fix main after "Release notes"`, tone: `text-muted`, detail: `` });
        expect(lineOf({ kind: `waiting`, at })).toEqual({ words: `Waiting for the next check`, tone: `text-muted`, detail: `` });
        expect(lineOf({ kind: `original`, conversationId: `notes`, at })).toEqual({ words: `Being fixed in notes`, tone: `text-muted`, detail: `` });
        expect(lineOf(undefined)).toEqual({ words: `Deciding who fixes it`, tone: `text-muted`, detail: `` });
        // Left to the reader: the only lines in the warning ink, and the only ones that say why.
        expect(lineOf({ kind: `reported`, at, detail: `Repairs after landing are switched off.` })).toEqual({
            words: `Nobody is fixing it`,
            tone: `text-warning`,
            detail: `Repairs after landing are switched off.`,
        });
        expect(lineOf({ kind: `spent`, at, detail: `Still red after 2 fresh attempt(s); it waits for you.` })).toEqual({
            words: `Out of fix attempts`,
            tone: `text-warning`,
            detail: `Still red after 2 fresh attempt(s); it waits for you.`,
        });
    });

    // Opened to be watched: nothing but the reader closes it.
    it(`stays open through a click elsewhere, a conversation opened from it, and its logs opened`, async () => {
        const { element } = mount(redStatus(), { open: `mainline` });

        document.body.click();
        document.body.dispatchEvent(new PointerEvent(`pointerdown`, { bubbles: true }));
        await nextTick();
        expect(panel(element)).not.toBeNull();

        buttonNamed(section(element, `result`), `Release notes`).click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`notes`, `Release notes`);
        expect(panel(element)).not.toBeNull();

        buttonNamed(section(element, `result`), `Fix main after "Release notes"`).click();
        await nextTick();
        expect(opened).toHaveBeenLastCalledWith(`land-fix-web-abc`, undefined);

        buttonNamed(section(element, `queued`), `Add Stripe checkout`).click();
        await nextTick();
        expect(opened).toHaveBeenLastCalledWith(`checkout`, `Add Stripe checkout`);

        buttonNamed(section(element, `result`), `Logs`).click();
        await nextTick();
        expect(watched).toHaveBeenCalledWith(`panel-web--verify`);
        expect(panel(element)).not.toBeNull();
        expect(openPanel.value).toBe(`mainline`);
    });

    // One terminal per project: while it is being checked again, its Logs sit with the running check.
    it(`opens a project's logs from the running check while it runs, and from its red while it does not`, () => {
        const status = redStatus();
        const checking: MainlineStatus = {
            ...status,
            projects: [{ ...status.projects[0]!, queued: [], running: { command: `pnpm verify`, startedAt: NOW - 5_000, lands: [] } }],
        };
        const { element } = mount(checking, { open: `mainline` });
        expect(buttonNamed(section(element, `result`), `Logs`)).toBeUndefined();
        buttonNamed(section(element, `checking`), `Logs`).click();
        expect(watched).toHaveBeenCalledWith(`panel-web--verify`);
        expect(wordsOf(section(element, `checking`))).toBe(`Checking web 5s Logs Re-check`);
    });

    it(`closes on its segment, its ×, or Escape inside it, and hands focus back to the segment`, async () => {
        const { element } = mount(redStatus(), { open: `mainline` });

        segment(element).click();
        await nextTick();
        expect(panel(element)).toBeNull();

        segment(element).click();
        await nextTick();
        panel(element)!.querySelector<HTMLButtonElement>(`button[aria-label="Close Main line"]`)!.click();
        await nextTick();
        expect(panel(element)).toBeNull();

        openPanel.value = `mainline`;
        await nextTick();
        panel(element)!.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
        await nextTick();
        await nextTick();
        expect(panel(element)).toBeNull();
        expect(document.activeElement).toBe(segment(element));
    });
    it(`lays out what a push left, the tree's own breakage first, six at a time`, async () => {
        const { element } = mount(pushedStatus(), { open: `mainline` });
        const block = panel(element)!.querySelector<HTMLElement>(`[data-section="push-intentic"]`)!;
        const rows = (): string[] => [...block.querySelectorAll(`[data-finding]`)].map((row) => wordsOf(row));

        // Under the road, one band for every project, and in it each project's line read like a Result row.
        expect(wordsOf(panel(element)!.querySelector(`[data-section="pushed"] h4`))).toBe(`Left at push 7`);
        expect(wordsOf(block.querySelector(`.h-6`))).toBe(`intentic 7 left`);
        expect(wordsOf(block.querySelector(`p`))).toBe(`725e054 · ${sinceWhen(PUSHED.at)} · main · 2 commits`);
        // Each row names the file or folder, not the five folders above it every row shares.
        expect(rows()).toEqual([
            `daemon-boundaries portability -> settings closes a cycle`,
            `layout workspace/explorer: 36 files, the baseline allows 33`,
            `layout workspace/files: 32 files`,
            `silent-catch workspace-trash.ts: 3 silent catch(es), the baseline allows 0`,
            `buttons SandboxMetricsDetails.vue:29  a bare <button>`,
            `paths workspace-trash.integration.test.ts:8  spells the state dir`,
        ]);

        const more = [...block.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === `+1 more`)!;
        more.click();
        await nextTick();
        expect(rows()).toHaveLength(7);
        expect(rows()[6]).toBe(`silent-catch workspace-trash.ts:127  .catch discards the error`);
        expect(more.textContent?.trim()).toBe(`Show fewer`);
    });

    it(`dismisses one finding or all of them, with an Undo that opens exactly those again`, async () => {
        const { element } = mount(pushedStatus(), { open: `mainline` });
        const block = panel(element)!.querySelector<HTMLElement>(`[data-section="push-intentic"]`)!;

        block.querySelector<HTMLButtonElement>(`button[aria-label="Dismiss layout"]`)!.click();
        await nextTick();
        expect(dismissed).toHaveBeenCalledWith(`intentic`, [`layout-1`]);
        // Gone from the column the moment it is pressed, before the status comes back without it.
        expect(block.querySelectorAll(`[data-finding]`)).toHaveLength(6);
        await Promise.resolve();
        await nextTick();
        const receipt = useNotifications().receipt.value!;
        expect(receipt.title).toBe(`Dismissed 1 finding`);
        await receipt.actions![0]!.run();
        expect(dismissed).toHaveBeenLastCalledWith(`intentic`, [`layout-1`], true);

        const all = [...block.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === `Dismiss all`)!;
        all.click();
        await nextTick();
        expect(dismissed).toHaveBeenLastCalledWith(`intentic`, [`daemon-1`, `layout-1`, `layout-2`, `silent-2`, `buttons-1`, `paths-1`, `silent-1`]);
    });

    it(`measures the project again on a press and says what the measurement found`, async () => {
        const { element } = mount(pushedStatus(), { open: `mainline` });
        panel(element)!.querySelector<HTMLButtonElement>(`[data-section="push-intentic"] button[aria-label="Measure again"]`)!.click();
        await nextTick();
        await Promise.resolve();
        expect(rechecked).toHaveBeenCalledWith(`intentic`);
        expect(useNotifications().receipt.value?.title).toBe(`Measured intentic again: 2 gone, 5 still open`);
    });

    it(`hands the findings to an agent only on a press, and opens the conversation it answers with`, async () => {
        const { element } = mount(pushedStatus(), { open: `mainline` });
        expect(handed).not.toHaveBeenCalled();

        panel(element)!.querySelector<HTMLButtonElement>(`[data-section="push-intentic"] [data-run]`)!.click();
        await nextTick();
        await Promise.resolve();
        expect(handed).toHaveBeenCalledWith(`intentic`, undefined, undefined);
        expect(opened).toHaveBeenCalledWith(`push-fix-intentic-0abc123`);
    });

    it(`opens the attempt already running when the daemon refuses a second one`, async () => {
        handed.mockRejectedValueOnce(new SandboxHttpError(409, `An agent is already on these findings.`));
        const { element } = mount(pushedStatus(), { open: `mainline` });
        panel(element)!.querySelector<HTMLButtonElement>(`[data-section="push-intentic"] [data-run]`)!.click();
        await nextTick();
        await Promise.resolve();
        await Promise.resolve();
        // Not in this roster yet, so it opens by the id every attempt 1 at these findings wears.
        expect(opened).toHaveBeenCalledWith(pushFixBase(LEFT_RED));
        expect(useNotifications().receipt.value).toBeUndefined();
    });

    it(`shows the agent already on them in place of a second press, with the way to its conversation`, async () => {
        attemptOnIt.value = {
            agent: {
                id: `push-fix-intentic-0abc123`,
                title: `Fix what the push left in intentic`,
                status: `running`,
                provider: `claude`,
                harness: `native`,
                updatedAt: NOW,
                attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
            },
            attempt: 1,
            stance: { kind: `working`, ongoing: true, retry: false, label: `Agent working`, hint: `An agent is already working on this failure.` },
        };
        const { element } = mount(pushedStatus(), { open: `mainline` });
        const block = panel(element)!.querySelector<HTMLElement>(`[data-section="push-intentic"]`)!;

        expect(block.querySelector(`[data-run]`)).toBeNull();
        expect(wordsOf(block.querySelector(`[data-attempt]`))).toBe(`Agent working Fix what the push left in intentic`);
        block.querySelector<HTMLButtonElement>(`[data-attempt] button`)!.click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`push-fix-intentic-0abc123`);
    });

    it(`keeps pushes in the record beside the lands' checks, by what each left`, () => {
        const status = pushedStatus();
        const { element } = mount({ ...status, pushed: [PUSHED, { ...CLEAN_PUSH, branch: `docs/verify-push` }] }, { open: `mainline` });
        const events = [...panel(element)!.querySelectorAll<HTMLElement>(`[data-section="history"] [data-event]`)];
        // Aged from the minute the panel reads, 40s before NOW: 12m reads as 11, 20m as 19, 300m as 4h. Two projects
        // between the lands and the pushes, so every row names its own. A push row says "push" to a screen reader and
        // shows only the commit (and a branch that is not main) beside its arrow.
        expect(events.map((event) => [event.dataset[`event`], wordsOf(event)])).toEqual([
            [`land`, `passed Add Stripe checkout web 11m ago`],
            [`push`, `push 725e054 725e054 7 left intentic 19m ago`],
            [`push`, `push 6c6a13a to docs/verify-push 6c6a13a clean → docs/verify-push intentic 4h ago`],
        ]);
    });
});

describe(`the board's status bar`, () => {
    afterEach(() => {
        showLiveMetrics.value = false;
    });

    it(`carries the geek metrics as a second segment at the bar's far end, and opens one panel at a time`, async () => {
        const { element } = mount(redStatus(), { metrics: metrics() });
        const segments = [...element.querySelectorAll<HTMLElement>(`[data-segment]`)].map((button) => button.dataset[`segment`]);
        expect(segments).toEqual([`mainline`, `metrics`]);
        expect(wordsOf(segment(element, `metrics`))).toContain(`CPU 23%`);

        segment(element, `metrics`).click();
        await nextTick();
        segment(element).click();
        await nextTick();
        // Tabs: the second press swaps the panel rather than adding one beside it.
        expect([...element.querySelectorAll<HTMLElement>(`[data-panel]`)].map((section) => section.dataset[`panel`])).toEqual([`mainline`]);
        expect(segment(element, `metrics`).getAttribute(`aria-expanded`)).toBe(`false`);
        expect(openPanel.value).toBe(`mainline`);
    });

    // One maximum for the seam and the drawing: a height kept from a taller window is drawn at this one's half, never
    // saved as something the panel cannot show.
    it(`draws a panel no taller than half the window, and no taller than 720px anywhere`, async () => {
        const { element } = mount(redStatus(), { open: `mainline` });
        const drawn = (): string => element.querySelector<HTMLElement>(`[data-status-panel]`)!.style.height;
        panelHeight.value = 700;
        await nextTick();
        expect([window.innerHeight, drawn()]).toEqual([768, `384px`]);
    });

    it(`draws metrics alone when main has never been checked`, () => {
        const { element } = mount(undefined, { metrics: metrics() });
        expect(element.querySelector(`[data-segment="mainline"]`)).toBeNull();
        expect(segment(element, `metrics`)).not.toBeNull();
    });
});

// A SANDBOX FROM BEFORE 2026-09-25: it serves the runs but no reds, no check terminals and no split failures. Nothing is
// rebuilt from its runs; the bar and the panel say it needs an update, and a current sandbox says neither.
describe(`the main line of an older sandbox`, () => {
    // What v1.312 served for the same moment as redStatus: the raw runs, and pushes with nothing saying what is owed.
    const olderStatus = (): MainlineStatus => ({
        projects: [{ project: `web`, queued: [], last: { ...RED, units: undefined, named: undefined }, redSince: RED.at }],
        recent: [{ ...RED, units: undefined, named: undefined }, green({ at: NOW - 90 * MINUTE })],
        pushed: [PUSHED],
    });

    it(`says on the bar that the sandbox needs an update, in place of a red it cannot lay or a pass it cannot vouch for`, () => {
        const { element } = mount(olderStatus());
        expect(wordsOf(segment(element))).toBe(`Sandbox needs an update`);
        expect(segment(element).textContent).not.toContain(`failing`);
        expect(segment(element).textContent).not.toContain(`left at push`);
    });

    it(`opens onto the note and the runs as served: no cause, no fixer, no logs, no failure list, no pushes`, () => {
        const { element } = mount(olderStatus(), { open: `mainline`, router: true });
        const docked = panel(element)!;
        const note = docked.querySelector<HTMLElement>(`[data-outdated]`)!;
        expect(wordsOf(note)).toBe(
            `This sandbox runs an older version Until it updates, this panel can't say who a failing check is laid at or who is fixing it, open a check's logs, or show what your pushes left behind. Update the sandbox Installed it yourself? Reinstall it, or run this on the machine that runs it: ic sandbox update`,
        );
        expect(note.querySelector(`a[data-update]`)?.getAttribute(`href`)).toBe(`/sandbox/overview`);
        expect(wordsOf(docked.querySelector(`[data-section="result"]`))).toBe(`Result web failing 30m ago`);
        expect(docked.querySelector(`[data-cause], [data-fix], [data-failures], [data-section="pushed"], [data-event="push"]`)).toBeNull();
        expect([...docked.querySelectorAll(`button`)].some((button) => wordsOf(button) === `Logs`)).toBe(false);
    });

    it(`draws no note for a current sandbox`, () => {
        const { element } = mount(redStatus(), { open: `mainline` });
        expect(panel(element)!.querySelector(`[data-outdated]`)).toBeNull();
        expect(wordsOf(segment(element))).not.toContain(`needs an update`);
    });
});
