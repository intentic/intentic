import "@intentic/testing/dom";
import type { Finding, MainlineProject, MainlinePush, MainlineRun, MainlineStatus, Red, SandboxMetrics } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

// The seam's dragging is the kit's own suite; here only what the status bar draws and when. The Main line's page is its
// own suite's too (mainline/Mainline.test.ts): here only that the bar says it and leads to it.
jest.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    return {
        ResizeSeam: vue.defineComponent({ setup: () => () => vue.h(`div`, { role: `separator` }) }),
        Meter: vue.defineComponent({ setup: () => () => vue.h(`div`, { "data-meter": `` }) }),
        ui: {
            iconButton: (extra: string) => extra,
            linkButton: (extra: string) => extra,
            textAction: (extra: string) => extra,
            sectionLabelSm: (extra: string) => extra,
        },
    };
});
// The metrics panel's session rows name conversations the way the board does; none are open in this suite.
jest.mock("../fleet/useAgents", () => ({ useAgents: () => ({ agentById: (_id: string) => undefined }) }));
jest.mock("../mainline/openLanded", () => ({ openLandConversation: () => undefined }));

const { default: BoardStatusBar } = await import("./BoardStatusBar.vue");
const { openPanel, panelHeight } = await import("./statusBarState");
const { showLiveMetrics } = await import("../metrics/liveMetrics");

const NOW = 10_000_000_000;
const MINUTE = 60_000;
const GIB = 2 ** 30;

let app: App | undefined;

interface Mounted {
    readonly element: HTMLElement;
    readonly router: Router;
}

// The bar's memory is the window's (two preferences), so a case that starts with the panel open sets it there. The
// router is the app's own: the main line's segment is a link into it.
const mount = (mainline: MainlineStatus | undefined, options: { metrics?: SandboxMetrics; open?: `metrics` } = {}): Mounted => {
    openPanel.value = options.open;
    panelHeight.value = 240;
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () => h(BoardStatusBar, { mainline, metrics: options.metrics }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: { render: () => null } }] });
    app.use(router);
    app.mount(element);
    return { element, router };
};

// An element's text pieces joined by a space, as they read; the compiled template keeps no whitespace between them.
const wordsOf = (node: Node | null | undefined): string =>
    node === null || node === undefined
        ? ``
        : [...node.childNodes]
              .map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? ``) : wordsOf(child)).trim())
              .filter((piece) => piece !== ``)
              .join(` `);

const segment = (element: HTMLElement, id = `mainline`): HTMLElement => element.querySelector<HTMLElement>(`[data-segment="${id}"]`)!;
const panel = (element: HTMLElement, id = `metrics`): HTMLElement | null => element.querySelector<HTMLElement>(`[data-panel="${id}"]`);

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
const leftFinding = (id: string, check: string, gate: `code` | `tidy`): Finding => ({ id, source: check, recheckable: true, gate, text: `${check} says so` });

const LEFT: Finding[] = [
    leftFinding(`paths-1`, `paths`, `tidy`),
    leftFinding(`silent-1`, `silent-catch`, `tidy`),
    leftFinding(`silent-2`, `silent-catch`, `code`),
    leftFinding(`layout-1`, `layout`, `code`),
    leftFinding(`layout-2`, `layout`, `code`),
    leftFinding(`daemon-1`, `daemon-boundaries`, `code`),
    leftFinding(`buttons-1`, `buttons`, `tidy`),
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

// What the project owes of it: everything the push found.
const LEFT_RED: Red = { source: `push`, scope: `intentic`, since: PUSHED.at, findings: LEFT, suspects: [], named: false, decisions: [] };

const pushedStatus = (): MainlineStatus => ({
    projects: [{ project: `web`, queued: [], last: green() }],
    recent: [green()],
    pushed: [PUSHED],
    reds: [LEFT_RED],
});

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
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

    // Its detail is a page's reading, read instead of the board: the segment leads there and opens nothing under the board.
    it(`sits in the status bar and leads to the Main line view, opening nothing over the board`, async () => {
        const { element, router } = mount(redStatus());
        expect(element.querySelector(`[role="region"]`)?.getAttribute(`aria-label`)).toBe(`Board status`);
        expect(segment(element).tagName).toBe(`A`);
        expect(segment(element).getAttribute(`href`)).toBe(`/ext/mainline`);
        expect(segment(element).hasAttribute(`aria-expanded`)).toBe(false);

        segment(element).click();
        await router.isReady();
        await nextTick();
        await nextTick();
        expect(router.currentRoute.value.path).toBe(`/ext/mainline`);
        expect(element.querySelector(`[data-panel]`)).toBeNull();
        expect(openPanel.value).toBeUndefined();
    });

    // Health and activity side by side; what the check runs and whose work it measures are the view's to say.
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
        // The bar is its segments and nothing else: who has the red is one press away, in the view.
        expect([...element.querySelectorAll<HTMLElement>(`a, button`)].map((control) => control.dataset[`segment`])).toEqual([`mainline`]);
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

describe(`the board's status bar`, () => {
    afterEach(() => {
        showLiveMetrics.value = false;
    });

    it(`carries the geek metrics at the bar's far end, and opens their panel above it`, async () => {
        const { element } = mount(redStatus(), { metrics: metrics() });
        const segments = [...element.querySelectorAll<HTMLElement>(`[data-segment]`)].map((control) => control.dataset[`segment`]);
        expect(segments).toEqual([`mainline`, `metrics`]);
        expect(wordsOf(segment(element, `metrics`))).toContain(`CPU 23%`);
        expect(segment(element, `metrics`).getAttribute(`aria-expanded`)).toBe(`false`);

        segment(element, `metrics`).click();
        await nextTick();
        expect(openPanel.value).toBe(`metrics`);
        expect(segment(element, `metrics`).getAttribute(`aria-expanded`)).toBe(`true`);
        const docked = panel(element)!;
        expect(segment(element, `metrics`).getAttribute(`aria-controls`)).toBe(docked.id);
        expect(wordsOf(docked.querySelector(`h3`))).toBe(`Sandbox resources`);
        expect([...element.querySelectorAll<HTMLElement>(`[data-panel]`)].map((section) => section.dataset[`panel`])).toEqual([`metrics`]);
    });

    // Opened to be watched: nothing but the reader closes it.
    it(`keeps the panel through a click elsewhere, and closes it on its segment, its ×, or Escape inside it, handing focus back`, async () => {
        const { element } = mount(undefined, { metrics: metrics(), open: `metrics` });

        document.body.click();
        document.body.dispatchEvent(new PointerEvent(`pointerdown`, { bubbles: true }));
        await nextTick();
        expect(panel(element)).not.toBeNull();

        segment(element, `metrics`).click();
        await nextTick();
        expect(panel(element)).toBeNull();

        segment(element, `metrics`).click();
        await nextTick();
        panel(element)!.querySelector<HTMLButtonElement>(`button[aria-label="Close Sandbox resources"]`)!.click();
        await nextTick();
        expect(panel(element)).toBeNull();

        openPanel.value = `metrics`;
        await nextTick();
        panel(element)!.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
        await nextTick();
        await nextTick();
        expect(panel(element)).toBeNull();
        expect(document.activeElement).toBe(segment(element, `metrics`));
    });

    // One maximum for the seam and the drawing: a height kept from a taller window is drawn at this one's half, never
    // saved as something the panel cannot show.
    it(`draws a panel no taller than half the window, and no taller than 720px anywhere`, async () => {
        const { element } = mount(redStatus(), { metrics: metrics(), open: `metrics` });
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

    // Left open while the metrics were turned off, it comes back as it was left once they are on again.
    it(`draws no panel while the metrics are off, whatever was left open`, () => {
        const { element } = mount(redStatus(), { open: `metrics` });
        expect(element.querySelector(`[data-status-panel]`)).toBeNull();
        expect(openPanel.value).toBe(`metrics`);
    });
});

// A SANDBOX FROM BEFORE 2026-09-25: it serves the runs but no reds, no check terminals and no split failures. Nothing is
// rebuilt from its runs; the bar says it needs an update, and a current sandbox's says nothing of the kind.
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

    it(`says nothing of an update on a current sandbox's bar`, () => {
        const { element } = mount(redStatus());
        expect(wordsOf(segment(element))).not.toContain(`needs an update`);
    });
});
