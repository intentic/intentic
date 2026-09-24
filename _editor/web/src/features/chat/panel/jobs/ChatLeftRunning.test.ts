import "@intentic/testing/dom";
import type { AgentJob, AgentWatch } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, shallowRef } from "vue";

const roster = { jobs: undefined as AgentJob[] | undefined, watches: undefined as AgentWatch[] | undefined };
const pane = { streaming: shallowRef(false) };
const stopJob = jest.fn((_id: string, _jobId: string) => Promise.resolve());
const stopWatching = jest.fn((_id: string, _watchId?: string) => Promise.resolve());
const previewed = jest.fn((_router: unknown, _target?: string) => undefined);
const watched = jest.fn((_session: string) => undefined);

jest.mock("../../../agents/fleet/useAgents", () => ({
    useAgents: () => ({ agentById: () => ({ jobs: roster.jobs, watches: roster.watches }), stopJob, stopWatching }),
}));
jest.mock("../useChat-view", () => ({ usePaneView: () => ({ conversation: shallowRef({ conversationId: `agent-1` }), streaming: pane.streaming }) }));
jest.mock("../../../sandbox/client/useSandbox", () => ({ useSandbox: () => ({ reachable: shallowRef(true) }) }));
jest.mock("../../tools/chatToolSurface", () => ({ useChatSurface: () => ({ watchTerminal: watched }) }));
jest.mock("../../../preview/previewSurface", () => ({ openPreview: previewed }));
jest.mock("vue-router", () => ({ useRouter: () => ({}) }));

const { default: ChatLeftRunning } = await import("./ChatLeftRunning.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatLeftRunning) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const NOW = 10_000_000;
const job = (over: Partial<AgentJob>): AgentJob => ({ id: `job`, label: `Build`, session: `agent-1`, startedAt: NOW - 65_000, ...over });
const watch = (over: Partial<AgentWatch>): AgentWatch => ({ id: `watch-1`, note: `CI on the pushed branch`, intervalSeconds: 60, deadlineAt: NOW + 3_600_000, ...over });

const buttons = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`button`)];
const labelled = (element: HTMLElement, text: string): HTMLButtonElement | undefined => buttons(element).find((button) => button.textContent?.trim() === text);

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    roster.jobs = undefined;
    roster.watches = undefined;
    pane.streaming.value = false;
    for (const mock of [stopJob, stopWatching, previewed, watched]) {
        mock.mockClear();
    }
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    jest.useRealTimers();
});

describe(`ChatLeftRunning`, () => {
    it(`says nothing for a chat with nothing left going, ended jobs included`, () => {
        roster.jobs = [job({ endedAt: NOW - 1_000, exitCode: 0 })];
        expect(mount().querySelector(`.chat-left-running`)).toBeNull();
    });

    it(`stays out of a streaming turn's way, whose own status line speaks for it`, () => {
        roster.jobs = [job({})];
        pane.streaming.value = true;
        expect(mount().querySelector(`.chat-left-running`)).toBeNull();
    });

    it(`says a finished turn's chat still wakes by itself, and on which job's exit`, () => {
        roster.jobs = [job({ id: `e2e`, label: `Run the web e2e suite`, watch: `watch-e2e` })];
        roster.watches = [watch({ id: `watch-e2e`, note: `Background job "Run the web e2e suite"`, deadlineAt: NOW + 5 * 3_600_000 })];
        const text = mount().querySelector(`.chat-left-running`)?.textContent ?? ``;
        expect(text).toContain(`Still running after the turn`);
        expect(text).toContain(`This chat wakes by itself when these finish.`);
        expect(text).toContain(`Run the web e2e suite`);
        expect(text).toContain(`Wakes this chat when it exits · 1m 5s, gives up in 5h 0m`);
        // The job's own watch is said on the job's row, not again as a row of its own.
        expect(text).not.toContain(`Background job "Run the web e2e suite"`);
    });

    it(`offers a server left for the person in Preview, and stops it without waking anything`, async () => {
        roster.jobs = [job({ id: `web`, label: `Start the web dev server`, handed: true, ports: [5173] })];
        const element = mount();
        const text = element.querySelector(`.chat-left-running`)?.textContent ?? ``;
        expect(text).toContain(`The agent left these running for you.`);
        expect(text).toContain(`Left running for you on :5173 · 1m 5s`);

        labelled(element, `Open in Preview`)?.click();
        expect(previewed).toHaveBeenCalledWith(expect.anything(), `port:5173`);

        labelled(element, `Stop`)?.click();
        await nextTick();
        expect(stopJob).toHaveBeenCalledWith(`agent-1`, `web`);
    });

    it(`lists a watch the agent armed with its pace and deadline, and disarms only it`, async () => {
        roster.watches = [watch({})];
        const element = mount();
        expect(element.textContent).toContain(`CI on the pushed branchChecks every 60s · gives up in 1h 0m`);
        labelled(element, `Stop watching`)?.click();
        await nextTick();
        expect(stopWatching).toHaveBeenCalledWith(`agent-1`, `watch-1`);
    });

    it(`draws a job being stopped as stopping, with no second Stop to press`, () => {
        roster.jobs = [job({ id: `web`, handed: true, ports: [5173], stoppedBy: `person` })];
        const element = mount();
        expect(element.textContent).toContain(`Stopping…`);
        expect(labelled(element, `Stop`)).toBeUndefined();
        expect(labelled(element, `Open in Preview`)).toBeUndefined();
    });

    it(`says why a stop was refused, under the card`, async () => {
        roster.jobs = [job({ id: `web`, handed: true, ports: [5173] })];
        stopJob.mockImplementationOnce(() => Promise.reject(new Error(`sandbox unreachable`)));
        const element = mount();
        labelled(element, `Stop`)?.click();
        await Promise.resolve();
        await nextTick();
        expect(element.querySelector(`[role="alert"]`)?.textContent).toContain(`sandbox unreachable`);
    });
});
