import "@intentic/testing/dom";
import type { MainlineRun, MainlineStatus, SandboxMetrics } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, ref } from "vue";
import type { DockState } from "./dockState";

const opened = jest.fn((_conversationId: string, _title?: string) => undefined);
const watched = jest.fn((_session: string) => undefined);

// The seam's dragging is the kit's own suite; here only what the dock draws and when.
jest.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    return {
        ResizeSeam: vue.defineComponent({ setup: () => () => vue.h(`div`, { role: `separator` }) }),
        ui: { iconButton: (extra: string) => extra, linkButton: (extra: string) => extra, textAction: (extra: string) => extra },
    };
});
jest.mock("../fleet/useAgents", () => ({
    useAgents: () => ({ agentById: (id: string) => (id === `land-fix-web-abc` ? { title: `Fix main after "Release notes"` } : undefined) }),
}));
jest.mock("../mainline/openLanded", () => ({
    openLandConversation: opened,
    useLandTitle: () => (conversationId: string, title?: string) =>
        title ?? (conversationId === `land-fix-web-abc` ? `Fix main after "Release notes"` : conversationId),
}));
jest.mock("../../terminal/useWorkTerminals", () => ({ openWorkTerminal: watched }));

const { default: AgentsDock } = await import("./AgentsDock.vue");
const { sinceWhen } = await import("../mainline/mainlineView");
const { showLiveMetrics } = await import("../metrics/liveMetrics");

const NOW = 10_000_000_000;
const MINUTE = 60_000;
const GIB = 2 ** 30;

let app: App | undefined;

const freshState = (open: string[] = []): DockState => ({ open: ref(open), height: ref(240) });

interface Mounted {
    readonly element: HTMLElement;
    readonly state: DockState;
}

const mount = (
    mainline: MainlineStatus | undefined,
    options: { metrics?: SandboxMetrics; state?: DockState; onOpened?: (id: string) => void } = {},
): Mounted => {
    const element = document.createElement(`div`);
    document.body.append(element);
    const state = options.state ?? freshState();
    app = createApp({
        render: () => h(AgentsDock, { mainline, metrics: options.metrics, state, label: `Board status`, onOpened: options.onOpened }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return { element, state };
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
    failureCount: 2,
    attempt: 1,
    suspects: [`notes`],
    routing: { kind: `fix-up`, conversationId: `land-fix-web-abc`, at: NOW - 30 * MINUTE, detail: `Its conversation had gone cold.` },
};

const redStatus = (): MainlineStatus => ({
    projects: [{ project: `web`, queued: [{ conversationId: `checkout`, title: `Add Stripe checkout`, at: NOW - 40_000 }], last: RED, redSince: RED.at }],
    recent: [RED, green({ at: NOW - 90 * MINUTE })],
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
            last: green(),
        },
    ],
    recent: [green()],
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

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    opened.mockClear();
    watched.mockClear();
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
        expect(mount({ projects: [], recent: [] }).element.querySelector(`[role="region"]`)).toBeNull();
    });

    it(`sits in the status bar, not over the board: no panel until the reader opens one`, () => {
        const { element } = mount(redStatus());
        expect(element.querySelector(`[role="region"]`)?.getAttribute(`aria-label`)).toBe(`Board status`);
        expect(segment(element).getAttribute(`aria-expanded`)).toBe(`false`);
        expect(element.querySelector(`[data-panel]`)).toBeNull();
    });

    it(`names what is running without a click: the project, how long, the command and whose work it measures`, async () => {
        const { element } = mount(runningStatus());
        expect(wordsOf(segment(element).querySelector(`[data-item="running"]`))).toBe(`Checking main web 1m 5s pnpm verify Add Stripe checkout +1`);

        jest.advanceTimersByTime(1_000);
        await nextTick();
        expect(wordsOf(segment(element))).toContain(`1m 6s`);
    });

    it(`says main is red, since when, and who has it, with the conversation one press away`, async () => {
        const onOpened = jest.fn((_id: string) => undefined);
        const { element } = mount(redStatus(), { onOpened });
        expect(wordsOf(segment(element).querySelector(`[data-item="red"]`))).toBe(`web red since ${sinceWhen(RED.at)} 2 failures`);
        // The queue is a count beside the red rather than a sentence of its own.
        expect(wordsOf(segment(element).querySelector(`[data-item="waiting"]`))).toBe(`1 waiting`);
        const routing = element.querySelector<HTMLElement>(`[data-routing]`)!;
        expect(routing.textContent).toContain(`A fresh conversation is fixing it`);
        // Beside the segment, never inside it: a button inside a button is two presses a reader cannot tell apart.
        expect(segment(element).contains(routing)).toBe(false);

        const open = routing.querySelector<HTMLButtonElement>(`button[aria-label^="Open "]`)!;
        expect(open.getAttribute(`aria-label`)).toBe(`Open Fix main after "Release notes"`);
        open.click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`land-fix-web-abc`);
        expect(onOpened).toHaveBeenCalledWith(`land-fix-web-abc`);
    });

    it(`keeps a red on the line while a check elsewhere runs`, () => {
        const status = redStatus();
        const { element } = mount({
            ...status,
            projects: [...status.projects, { project: `api`, running: { command: `pnpm test`, startedAt: NOW - 5_000, lands: [] }, queued: [] }],
        });
        expect(wordsOf(segment(element).querySelector(`[data-item="running"]`))).toBe(`Checking main api 5s pnpm test re-check`);
        expect(wordsOf(segment(element).querySelector(`[data-item="red"]`))).toBe(`web red`);
        expect(element.textContent).toContain(`A fresh conversation is fixing it`);
    });

    it(`says main is green and when it was last checked, only while nothing else has news`, () => {
        const { element } = mount({ projects: [{ project: `web`, queued: [], last: green() }], recent: [green()] });
        expect(wordsOf(segment(element))).toMatch(/^Main green checked 1\dm ago$/);
        expect(element.querySelector(`[data-routing]`)).toBeNull();
    });

    it(`counts the lands waiting for the next check, each once`, () => {
        const waiting = { conversationId: `a`, at: NOW - 5_000 };
        const { element } = mount({
            projects: [
                { project: `web`, queued: [waiting, { conversationId: `b`, at: NOW - 3_000 }], last: green() },
                // The same land waiting in a second project is still one land.
                { project: `api`, queued: [waiting] },
            ],
            recent: [green()],
        });
        expect(wordsOf(segment(element))).toBe(`2 lands waiting for main's check`);
    });
});

describe(`the main line's panel`, () => {
    it(`opens docked above the bar onto the red run's failures, what became of them, the queue and the record`, async () => {
        const { element, state } = mount(redStatus());
        segment(element).click();
        await nextTick();

        expect(state.open.value).toEqual([`mainline`]);
        expect(segment(element).getAttribute(`aria-expanded`)).toBe(`true`);
        const docked = panel(element)!;
        expect(segment(element).getAttribute(`aria-controls`)).toBe(docked.id);
        expect(docked.textContent).toContain(`No check running`);
        expect(docked.textContent).toContain(`web red since ${sinceWhen(RED.at)}`);
        expect(docked.textContent).toContain(`changelog.test.ts › lists every release`);
        expect(docked.textContent).toContain(`Its conversation had gone cold.`);
        expect(docked.textContent).toContain(`Waiting for the next check`);
        expect(docked.textContent).toContain(`Add Stripe checkout`);
        expect(docked.textContent).toContain(`Recent checks`);
    });

    it(`lists every land the running check measures`, () => {
        const { element } = mount(runningStatus(), { state: freshState([`mainline`]) });
        const now = panel(element)!.querySelector(`[data-section="now"]`)!;
        expect(now.textContent).toContain(`Checking web now`);
        expect(now.textContent).toContain(`pnpm verify`);
        expect(now.textContent).toContain(`Add Stripe checkout`);
        expect(now.textContent).toContain(`Tighten the pricing copy`);
    });

    // Opened to be watched: nothing but the reader closes it.
    it(`stays open through a click elsewhere, a conversation opened from it, and a terminal watched from it`, async () => {
        const { element, state } = mount(redStatus(), { state: freshState([`mainline`]) });

        document.body.click();
        document.body.dispatchEvent(new PointerEvent(`pointerdown`, { bubbles: true }));
        await nextTick();
        expect(panel(element)).not.toBeNull();

        panel(element)!.querySelector<HTMLButtonElement>(`button[aria-label="Open Release notes"]`)!.click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`notes`, `Release notes`);
        expect(panel(element)).not.toBeNull();

        panel(element)!.querySelector<HTMLButtonElement>(`button[aria-label="Watch in terminal"]`)!.click();
        await nextTick();
        expect(watched).toHaveBeenCalledWith(`panel-web--verify`);
        expect(panel(element)).not.toBeNull();
        expect(state.open.value).toEqual([`mainline`]);
    });

    it(`closes on its segment, its ×, or Escape inside it, and hands focus back to the segment`, async () => {
        const { element, state } = mount(redStatus(), { state: freshState([`mainline`]) });

        segment(element).click();
        await nextTick();
        expect(panel(element)).toBeNull();

        segment(element).click();
        await nextTick();
        panel(element)!.querySelector<HTMLButtonElement>(`button[aria-label="Close Main line"]`)!.click();
        await nextTick();
        expect(panel(element)).toBeNull();

        state.open.value = [`mainline`];
        await nextTick();
        panel(element)!.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
        await nextTick();
        await nextTick();
        expect(panel(element)).toBeNull();
        expect(document.activeElement).toBe(segment(element));
    });
});

describe(`the board's dock`, () => {
    afterEach(() => {
        showLiveMetrics.value = false;
    });

    it(`carries the geek metrics as a second segment at the bar's far end, and both panels side by side`, async () => {
        const { element, state } = mount(redStatus(), { metrics: metrics() });
        const segments = [...element.querySelectorAll<HTMLElement>(`[data-segment]`)].map((button) => button.dataset[`segment`]);
        expect(segments).toEqual([`mainline`, `metrics`]);
        expect(wordsOf(segment(element, `metrics`))).toContain(`CPU 23%`);

        segment(element, `metrics`).click();
        await nextTick();
        segment(element).click();
        await nextTick();
        // In the bar's order, whichever was opened first.
        expect([...element.querySelectorAll<HTMLElement>(`[data-panel]`)].map((section) => section.dataset[`panel`])).toEqual([`mainline`, `metrics`]);
        expect(state.open.value).toEqual([`metrics`, `mainline`]);
    });

    it(`turns geek metrics off from the metrics panel`, async () => {
        showLiveMetrics.value = true;
        const { element } = mount(undefined, { metrics: metrics(), state: freshState([`metrics`]) });
        const hide = [...panel(element, `metrics`)!.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Hide`)!;
        hide.click();
        await nextTick();
        expect(showLiveMetrics.value).toBe(false);
    });

    it(`draws metrics alone when main has never been checked`, () => {
        const { element } = mount(undefined, { metrics: metrics() });
        expect(element.querySelector(`[data-segment="mainline"]`)).toBeNull();
        expect(segment(element, `metrics`)).not.toBeNull();
    });
});
