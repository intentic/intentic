import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import type { TranscriptBackgroundJob } from "@intentic/sandbox-contract/events/transcript";
import type { AgentJob } from "@intentic/sandbox-contract/schemas/agents";
import { type App, createApp, h, nextTick, reactive } from "vue";
import { useToolCalls } from "../../../../models/conversations/tools/useToolCalls";
import { shownText } from "../../../../testing/shownText";
import ChatJobGroup from "./ChatJobGroup.vue";

const jobs: readonly TranscriptBackgroundJob[] = [1, 2, 3].map((id) => ({
    id: `job-${id}`, label: `Check ${id}`, command: `check ${id}`, startedAt: id * 1000,
}));
const finished = (): AgentJob[] => jobs.map((job) => ({
    id: job.id, label: job.label, session: `session`, startedAt: job.startedAt, endedAt: job.startedAt + 52_000, exitCode: 0,
}));
let app: App | undefined;
const mount = (live: AgentJob[] = finished()) => {
    const state = reactive({ live });
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () => h(ChatJobGroup, { jobs, live: state.live }, {
            default: ({ inspect }: { inspect: () => void }) => [h(`button`, { onClick: inspect }, `Inspect command`), h(`input`, { defaultValue: `Command detail` })],
        }),
    });
    app.component(`Icon`, IconStub);
    app.mount(element);
    return { element, state };
};
const band = (element: HTMLElement) => element.querySelector<HTMLButtonElement>(`.chat-spine-wash`);

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    useToolCalls().showToolCalls.value = false;
});

it(`uses one counted disclosure for three ended jobs and retains inspected content across folding`, async () => {
    const { element } = mount();
    expect(element.querySelectorAll(`.chat-spine-wash`)).toHaveLength(1);
    expect(band(element)!.getAttribute(`aria-label`)).toBe(`Show 3 background jobs`);
    expect(shownText(element)).not.toContain(`Inspect command`);
    const input = element.querySelector(`input`)!;
    input.value = `Inspected detail`;

    band(element)!.click();
    await nextTick();
    expect(shownText(element)).toContain(`Inspect command`);
    expect(element.querySelector(`input`)).toBe(input);
    expect(input.value).toBe(`Inspected detail`);
    element.querySelector<HTMLButtonElement>(`.chat-spine-node`)!.click();
    await nextTick();
    expect(band(element)!.getAttribute(`aria-expanded`)).toBe(`false`);
    expect(shownText(element)).not.toContain(`Inspect command`);
});

it(`keeps a failure visible in the folded band's colour and accessible name`, () => {
    const live = finished();
    live[1] = { ...live[1]!, exitCode: 2 };
    const { element } = mount(live);
    expect(band(element)!.classList.contains(`chat-spine-wash-failed`)).toBe(true);
    expect(band(element)!.getAttribute(`aria-label`)).toBe(`Show 3 background jobs · 1 failed`);
});

it(`leaves rows visible until every job ends, including a server left for the reader`, async () => {
    const live = finished();
    live[2] = { id: `job-3`, label: `Server`, session: `session`, startedAt: 3000, handed: true, ports: [5173] };
    const { element, state } = mount(live);
    expect(band(element)).toBeNull();
    expect(shownText(element)).toContain(`Inspect command`);
    state.live = finished();
    await nextTick();
    expect(band(element)!.getAttribute(`aria-label`)).toBe(`Show 3 background jobs`);
});

it(`keeps a command being inspected open when the last running job ends`, async () => {
    const { element, state } = mount([{ id: `job-1`, label: `Check 1`, session: `session`, startedAt: 1000 }]);
    element.querySelector<HTMLButtonElement>(`button`)!.click();
    state.live = finished();
    await nextTick();
    expect(band(element)).toBeNull();
    expect(shownText(element)).toContain(`Inspect command`);
    expect(element.querySelector(`.chat-spine-node`)!.getAttribute(`aria-expanded`)).toBe(`true`);
});

it(`opens for find-in-page and respects the preference to show all steps`, async () => {
    const { element } = mount([]);
    expect(band(element)!.getAttribute(`aria-label`)).toBe(`Show 3 background jobs`);
    element.querySelector(`[hidden]`)!.dispatchEvent(new Event(`beforematch`));
    await nextTick();
    expect(band(element)).toBeNull();
    expect(shownText(element)).toContain(`Inspect command`);

    element.querySelector<HTMLButtonElement>(`.chat-spine-node`)!.click();
    await nextTick();
    useToolCalls().showToolCalls.value = true;
    await nextTick();
    expect(band(element)).toBeNull();
    expect(shownText(element)).toContain(`Inspect command`);
});
