import "@intentic/testing/dom";
import type { MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick } from "vue";

const opened = jest.fn((_conversationId: string, _title?: string) => undefined);
const watched = jest.fn((_session: string) => undefined);

// The overlay's placement is the kit's own suite; here only whether its contents are drawn.
jest.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    return {
        AnchoredOverlay: vue.defineComponent({
            props: { modelValue: { type: Boolean, required: true } },
            setup:
                (props, { slots }) =>
                () =>
                    props.modelValue ? vue.h(`div`, { class: `overlay` }, slots[`default`]?.()) : undefined,
        }),
        ui: { iconButton: (extra: string) => extra, linkButton: (extra: string) => extra },
    };
});
jest.mock("../fleet/useAgents", () => ({
    useAgents: () => ({ agentById: (id: string) => (id === `land-fix-web-abc` ? { title: `Fix main after "Release notes"` } : undefined) }),
}));
jest.mock("./openLanded", () => ({ openLandConversation: opened }));
jest.mock("../../terminal/useWorkTerminals", () => ({ openWorkTerminal: watched }));

const { default: MainlineStrip } = await import("./MainlineStrip.vue");
const { sinceWhen } = await import("./mainlineView");

const NOW = 10_000_000_000;
const MINUTE = 60_000;

let app: App | undefined;

const mount = (status: MainlineStatus | undefined, onOpened?: (id: string) => void): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(MainlineStrip, { status, onOpened }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

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

const trigger = (element: HTMLElement): HTMLButtonElement => element.querySelector<HTMLButtonElement>(`button[aria-expanded]`)!;

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

describe(`MainlineStrip`, () => {
    it(`draws nothing while no land has been checked, or while the daemon does not say`, () => {
        expect(mount(undefined).querySelector(`[role="group"]`)).toBeNull();
        app?.unmount();
        expect(mount({ projects: [], recent: [] }).querySelector(`[role="group"]`)).toBeNull();
    });

    it(`counts a running check up by the second, with the lands it answers for`, async () => {
        const element = mount({
            projects: [
                {
                    project: `web`,
                    running: { command: `pnpm verify`, startedAt: NOW - 65_000, lands: [{ conversationId: `checkout`, at: NOW - 70_000 }] },
                    queued: [],
                    last: green(),
                },
            ],
            recent: [green()],
        });
        expect(trigger(element).textContent).toContain(`Checking main · web · 1 land · 1m 5s`);

        jest.advanceTimersByTime(1_000);
        await nextTick();
        expect(trigger(element).textContent).toContain(`1m 6s`);
    });

    it(`says main is red, since when, and who has it, with the conversation one press away`, async () => {
        const onOpened = jest.fn((_id: string) => undefined);
        const element = mount(redStatus(), onOpened);
        expect(trigger(element).textContent).toContain(`Main is red · web · 2 failures · since ${sinceWhen(RED.at)}`);
        expect(element.textContent).toContain(`A fresh conversation is fixing it`);

        const open = element.querySelector<HTMLButtonElement>(`button[aria-label^="Open "]`)!;
        expect(open.getAttribute(`aria-label`)).toBe(`Open Fix main after "Release notes"`);
        open.click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`land-fix-web-abc`, `Fix main after "Release notes"`);
        expect(onOpened).toHaveBeenCalledWith(`land-fix-web-abc`);
    });

    it(`keeps a red on the line while a check elsewhere leads it`, () => {
        const status = redStatus();
        const element = mount({
            ...status,
            projects: [...status.projects, { project: `api`, running: { command: `pnpm test`, startedAt: NOW - 5_000, lands: [] }, queued: [] }],
        });
        expect(trigger(element).textContent).toContain(`Checking main · api · 0 lands`);
        expect(trigger(element).textContent).toContain(`web red`);
        expect(element.textContent).toContain(`A fresh conversation is fixing it`);
    });

    it(`says main is green and when it was last checked`, () => {
        const element = mount({ projects: [{ project: `web`, queued: [], last: green() }], recent: [green()] });
        expect(trigger(element).textContent).toContain(`Main green · checked`);
        expect(element.textContent).not.toContain(`fixing`);
    });

    it(`counts the lands waiting for the next check`, () => {
        const waiting = { conversationId: `a`, at: NOW - 5_000 };
        const element = mount({
            projects: [
                { project: `web`, queued: [waiting, { conversationId: `b`, at: NOW - 3_000 }], last: green() },
                // The same land waiting in a second project is still one land.
                { project: `api`, queued: [waiting] },
            ],
            recent: [green()],
        });
        expect(trigger(element).textContent).toContain(`2 lands waiting for main's check`);
    });

    it(`opens onto the red run's failures, what became of them, the queue and the record`, async () => {
        const element = mount(redStatus());
        expect(element.querySelector(`.overlay`)).toBeNull();

        trigger(element).click();
        await nextTick();
        const overlay = element.querySelector<HTMLElement>(`.overlay`)!;
        expect(overlay.textContent).toContain(`web red since ${sinceWhen(RED.at)}`);
        expect(overlay.textContent).toContain(`changelog.test.ts › lists every release`);
        expect(overlay.textContent).toContain(`Its conversation had gone cold.`);
        expect(overlay.textContent).toContain(`Waiting for the next check`);
        expect(overlay.textContent).toContain(`Add Stripe checkout`);
        expect(overlay.textContent).toContain(`Recent checks`);
        expect(overlay.textContent).toContain(`Release notes`);
    });

    // The first thing a reader asks of a red is whose it is: the land it arrived with opens like any other.
    it(`names the land a red arrived with, and opens it`, async () => {
        const element = mount(redStatus());
        trigger(element).click();
        await nextTick();
        const overlay = element.querySelector<HTMLElement>(`.overlay`)!;
        expect(overlay.textContent).toContain(`Arrived with`);
        overlay.querySelector<HTMLButtonElement>(`button[aria-label="Open Release notes"]`)!.click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`notes`, `Release notes`);
        expect(element.querySelector(`.overlay`)).toBeNull();
    });

    it(`watches a project's check in the terminal it runs in, and gets out of the way`, async () => {
        const element = mount(redStatus());
        trigger(element).click();
        await nextTick();
        element.querySelector<HTMLButtonElement>(`.overlay button[aria-label="Watch in terminal"]`)!.click();
        await nextTick();
        expect(watched).toHaveBeenCalledWith(`panel-web--verify`);
        expect(element.querySelector(`.overlay`)).toBeNull();
    });
});
