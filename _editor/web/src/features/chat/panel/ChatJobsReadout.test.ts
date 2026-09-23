import "@intentic/testing/dom";
import type { AgentJob } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, shallowRef } from "vue";

const roster = { jobs: undefined as AgentJob[] | undefined };
const opened = jest.fn((_session: string) => undefined);

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
        ui: { iconButton: (extra: string) => extra },
    };
});
jest.mock("../../agents/fleet/useAgents", () => ({ useAgents: () => ({ agentById: () => ({ jobs: roster.jobs }) }) }));
jest.mock("./useChat-view", () => ({ usePaneView: () => ({ conversation: shallowRef({ conversationId: `agent-1` }) }) }));
jest.mock("../../terminal/useWorkTerminals", () => ({ openWorkTerminal: opened }));

const { default: ChatJobsReadout } = await import("./ChatJobsReadout.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatJobsReadout) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const job = (over: Partial<AgentJob>): AgentJob => ({ id: `job`, label: `Build`, session: `agent-1`, startedAt: Date.now() - 65_000, ...over });

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000_000);
    roster.jobs = undefined;
    opened.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    jest.useRealTimers();
});

describe(`ChatJobsReadout`, () => {
    it(`says nothing while nothing runs, ended jobs included`, () => {
        roster.jobs = [job({ endedAt: Date.now() - 1_000, exitCode: 0 })];
        expect(mount().querySelector(`button`)).toBeNull();
    });

    it(`counts the running jobs, and opens onto each with how long it has run`, async () => {
        roster.jobs = [job({ id: `e2e`, label: `Run the web e2e suite` }), job({ id: `tc`, label: `Typecheck`, startedAt: Date.now() - 5_000 })];
        const element = mount();
        const trigger = element.querySelector<HTMLButtonElement>(`button[aria-expanded]`)!;
        expect(trigger.textContent).toContain(`2 jobs running`);
        expect(element.querySelector(`.overlay`)).toBeNull();

        trigger.click();
        await nextTick();
        const overlay = element.querySelector(`.overlay`)!;
        expect(overlay.textContent).toContain(`Run the web e2e suite`);
        expect(overlay.textContent).toContain(`1m 5s`);
        expect(overlay.textContent).toContain(`Typecheck`);
    });

    it(`opens a job's own terminal and gets out of the way`, async () => {
        roster.jobs = [job({ session: `agent-7` })];
        const element = mount();
        element.querySelector<HTMLButtonElement>(`button[aria-expanded]`)!.click();
        await nextTick();
        element.querySelector<HTMLButtonElement>(`.overlay button`)!.click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`agent-7`);
        expect(element.querySelector(`.overlay`)).toBeNull();
    });
});
