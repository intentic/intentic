import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import type { AgentJob } from "@intentic/sandbox-contract/schemas/agents";
import { type App, createApp, h, nextTick, reactive } from "vue";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { useToolCalls } from "../../../../models/conversations/tools/useToolCalls";
import { shownText } from "../../../../testing/shownText";
import ChatStepGroup from "./ChatStepGroup.vue";
import { type StepGroup, stepsFold } from "./stepGroups";

const jobRows: readonly ChatMessage[] = [1, 2, 3].map((id) => ({
    id, role: `notice`, text: ``,
    backgroundJob: { id: `job-${id}`, label: `Check ${id}`, command: `check ${id}`, startedAt: id * 1000 },
}));
const callRow = (id: number, text = ``): ChatMessage => ({
    id, role: `assistant`, text,
    tools: [
        { id: `read-${id}`, name: `Read`, category: `read`, status: `completed` },
        { id: `bash-${id}`, name: `Bash`, category: `execute`, status: `failed` },
    ],
});
const finished = (): AgentJob[] => jobRows.map((row) => ({
    id: row.backgroundJob!.id, label: row.backgroundJob!.label, session: `session`, startedAt: row.backgroundJob!.startedAt,
    endedAt: row.backgroundJob!.startedAt + 52_000, exitCode: 0,
}));
let app: App | undefined;
// The pane's part, played here: it holds whether the group is open and whether it folds (useStepGroups).
const mount = (live: AgentJob[] = finished(), group: StepGroup = { head: 1, members: jobRows }) => {
    const state = reactive({ live, open: false });
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () => h(ChatStepGroup, {
            group,
            live: state.live,
            folds: stepsFold(group, state.live, useToolCalls().showToolCalls.value),
            open: state.open,
            "onUpdate:open": (open: boolean) => {
                state.open = open;
            },
        }, {
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

it(`counts jobs, calls and a reply's leading calls as one run of steps`, async () => {
    const { element } = mount(finished(), { head: 1, members: [jobRows[0]!, callRow(2), jobRows[1]!], tail: callRow(3, `Done.`) });
    expect(element.querySelectorAll(`.chat-spine-wash`)).toHaveLength(1);
    // Two jobs and four calls, two of them failed.
    expect(band(element)!.getAttribute(`aria-label`)).toBe(`Show 6 steps · 2 failed`);
    expect(band(element)!.classList.contains(`chat-spine-wash-failed`)).toBe(true);
    band(element)!.click();
    await nextTick();
    // The tail's own opened run carries the press that keeps every run open, not the group.
    expect(shownText(element)).not.toContain(`Always show steps`);
});

it(`offers to keep every run open where a group without a tail is opened`, async () => {
    const { element } = mount(finished(), { head: 1, members: [jobRows[0]!, callRow(2)] });
    band(element)!.click();
    await nextTick();
    const always = [...element.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === `Always show steps`);
    always!.click();
    await nextTick();
    expect(useToolCalls().showToolCalls.value).toBe(true);
    expect(band(element)).toBeNull();
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
