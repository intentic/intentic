// Pins what an assistant row leaves on the spine: one control for the thought and the hidden run together, the run's
// weight as a band that grows per call and never a number, and the same rows the shown mode draws once it is opened. Needs jsdom since all of it is render behavior,
// not throws.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { useToolCalls } from "../../tools/useToolCalls";
import { shownText } from "../../../../testing/shownText";

// Same runtime globals as ChatToolCard's suite (window.matchMedia, window.env), absent in jsdom.

const { default: ChatTurnAsides } = await import("./ChatTurnAsides.vue");

const { showToolCalls } = useToolCalls();

let app: App | undefined;
let tips: unknown[] = [];
const mount = (props: { tools?: readonly TranscriptTool[]; thinking?: string; live?: boolean }): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatTurnAsides, { live: false, ...props }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {
        mounted: (_element, binding) => {
            tips.push(binding.value);
        },
    });
    app.mount(element);
    return element;
};

beforeEach(() => {
    // The preference is account-wide and persists across mounts; every case states the mode it is about.
    showToolCalls.value = false;
    tips = [];
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// Closing is a `<Transition>`, so material leaves with the reveal, not the tick that shut it; jsdom has no real
// duration, so this waits two animation frames instead of 160ms.
const settle = async (): Promise<void> => {
    await nextTick();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await nextTick();
};

const nodes = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`.chat-spine-node`)];
// The control a row offers: the thought's mark where there is one, else the run's wash.
const controls = (element: HTMLElement): HTMLButtonElement[] => [
    ...element.querySelectorAll<HTMLButtonElement>(`.chat-spine-node, .chat-spine-wash:not([tabindex="-1"])`),
];
const wash = (element: HTMLElement): HTMLButtonElement | null => element.querySelector<HTMLButtonElement>(`.chat-spine-wash`);
const reads = (count: number): TranscriptTool[] => Array.from({ length: count }, (_, index) => read(`f${index}.ts`));

let next = 0;
const tool = (over: Partial<TranscriptTool> & Pick<TranscriptTool, "category">): TranscriptTool => ({
    id: `t${(next += 1)}`,
    name: `Tool`,
    status: `completed`,
    ...over,
});
const read = (path: string): TranscriptTool => tool({ category: `read`, name: `Read`, target: path });
const edit = (path: string): TranscriptTool => tool({ category: `edit`, name: `Edit`, target: path });

describe(`ChatTurnAsides run node`, () => {
    it(`stands in for the whole run as a wash with no figure, and nothing of the calls`, () => {
        const element = mount({ tools: [read(`a.ts`), read(`b.ts`), edit(`c.ts`)] });
        expect(nodes(element)).toHaveLength(0);
        expect(wash(element)?.textContent?.trim()).toBe(``);
        expect(wash(element)?.querySelector(`[data-icon]`)).toBeNull();
        expect(element.textContent).not.toContain(`a.ts`);
    });

    it(`grows a step per call, up to a cap, and no further`, () => {
        const callsOf = (count: number): string | undefined =>
            mount({ tools: reads(count) }).querySelector<HTMLElement>(`.chat-spine`)?.style.getPropertyValue(`--wash-calls`);
        expect(callsOf(1)).toBe(`1`);
        expect(callsOf(7)).toBe(`7`);
        expect(callsOf(16)).toBe(`16`);
        expect(callsOf(40)).toBe(`16`);
    });

    it(`stays shut until pressed`, () => {
        const element = mount({ tools: [read(`a.ts`)] });
        expect(element.querySelector(`.chat-spine`)?.classList.contains(`chat-spine-shut`)).toBe(true);
    });

    it(`opens onto the calls themselves, and closes again`, async () => {
        const element = mount({ tools: [read(`a.ts`), read(`b.ts`), edit(`c.ts`)] });
        const node = controls(element)[0]!;
        expect(node.getAttribute(`aria-expanded`)).toBe(`false`);

        node.click();
        await nextTick();
        expect(node.getAttribute(`aria-expanded`)).toBe(`true`);
        expect(element.querySelector(`.chat-spine`)?.classList.contains(`chat-spine-open`)).toBe(true);
        expect(element.textContent).toContain(`a.ts`);
        expect(element.textContent).toContain(`c.ts`);

        node.click();
        await settle();
        // Dropped from the DOM, not merely hidden.
        expect(element.textContent).not.toContain(`a.ts`);
        expect(node.getAttribute(`aria-expanded`)).toBe(`false`);
    });

    it(`says how many steps it is offering to the screen reader, and what they were on hover`, () => {
        expect(controls(mount({ tools: [read(`a.ts`)] }))[0]?.getAttribute(`aria-label`)).toBe(`Show 1 step`);
        tips = [];
        expect(controls(mount({ tools: [read(`a.ts`), read(`b.ts`), edit(`c.ts`)] }))[0]?.getAttribute(`aria-label`)).toBe(`Show 3 steps`);
        expect(tips.at(-1)).toEqual({
            title: `3 steps`,
            rows: [
                { label: `Edits`, value: 1 },
                { label: `Reads`, value: 2 },
            ],
            note: undefined,
        });
    });

    it(`turns and counts the failures on its card when a call failed`, () => {
        const element = mount({ tools: [read(`a.ts`), tool({ category: `execute`, name: `Bash`, status: `failed` })] });
        expect(wash(element)?.classList.contains(`chat-spine-wash-failed`)).toBe(true);
        expect(tips.at(-1)).toMatchObject({
            rows: [
                { label: `Commands`, value: 1 },
                { label: `Reads`, value: 1 },
                { label: `Failed`, value: 1, tone: `danger` },
            ],
        });
    });

    it(`breathes while the row is being written, and never spins`, () => {
        const running = [read(`a.ts`), tool({ category: `execute`, name: `Bash`, status: `in_progress` })];
        const live = mount({ tools: running, live: true });
        expect(wash(live)?.classList.contains(`chat-spine-wash-live`)).toBe(true);
        expect(live.querySelector(`[data-spin]`)).toBeNull();
        // Same run, replayed from history (live=false).
        expect(wash(mount({ tools: running, live: false }))?.classList.contains(`chat-spine-wash-live`)).toBe(false);
    });

    it(`draws nothing at all for a row that made no calls and thought nothing`, () => {
        expect(mount({ tools: [] }).querySelector(`button`)).toBeNull();
    });

    it(`draws the calls as rows, and no wash, for a reader who asked to see them`, () => {
        showToolCalls.value = true;
        const element = mount({ tools: [read(`a.ts`), edit(`c.ts`)] });

        expect(controls(element)).toHaveLength(0);
        expect(wash(element)).toBeNull();
        expect(element.textContent).toContain(`a.ts`);
        expect(element.textContent).toContain(`c.ts`);
    });
});

// A thought and the run it led to are one seam between two paragraphs, so they are one node: two marks side by side
// were the clutter this replaced.
describe(`ChatTurnAsides thought on the node`, () => {
    const thinking = `The tile already renders a status dot, so the badge should reuse that lane.`;

    it(`shares the run's node, and opens with it`, async () => {
        const element = mount({ thinking, tools: [read(`a.ts`)] });

        const [node, ...others] = nodes(element);
        expect(others).toHaveLength(0);
        expect(node?.querySelector(`[data-icon="sparkles"]`)).not.toBeNull();
        expect(node?.textContent?.trim()).toBe(``);
        // The run still shows as a wash, which the pointer may press but the keyboard and screen reader skip.
        expect(wash(element)?.getAttribute(`tabindex`)).toBe(`-1`);
        expect(wash(element)?.getAttribute(`aria-hidden`)).toBe(`true`);
        expect(node?.getAttribute(`aria-label`)).toBe(`Show thinking and 1 step`);
        expect(shownText(element)).not.toContain(thinking);

        node!.click();
        await nextTick();
        expect(shownText(element)).toContain(thinking);
        expect(element.textContent).toContain(`a.ts`);
    });

    it(`stands alone as a thought when the row ran nothing`, () => {
        const node = nodes(mount({ thinking }))[0];
        expect(node?.getAttribute(`aria-label`)).toBe(`Thinking`);
        expect(node?.textContent?.trim()).toBe(``);
    });

    it(`reads as it is written and puts itself away once the turn lands, without opening the run`, async () => {
        const live = mount({ thinking, tools: [read(`a.ts`)], live: true });
        expect(shownText(live)).toContain(thinking);
        // Hiding the run is what the reader chose; only the thought opens itself.
        expect(live.textContent).not.toContain(`a.ts`);

        app?.unmount();
        app = undefined;
        document.body.innerHTML = ``;

        const settled = mount({ thinking, live: false });
        expect(shownText(settled)).not.toContain(thinking);
    });

    it(`keeps a shut thought in the page for find-in-page, and opens it when a match lands inside`, async () => {
        const element = mount({ thinking, tools: [read(`a.ts`)] });
        const shut = element.querySelector(`[hidden="until-found"]`)!;
        expect(shut.textContent).toBe(thinking);
        // The run is not text worth the page's weight: it stays absent until pressed.
        expect(element.textContent).not.toContain(`a.ts`);

        shut.dispatchEvent(new Event(`beforematch`));
        await nextTick();
        expect(shut.hasAttribute(`hidden`)).toBe(false);
        expect(shut.classList.contains(`chat-mark-found`)).toBe(true);
        expect(nodes(element)[0]?.getAttribute(`aria-expanded`)).toBe(`true`);
    });

    it(`keeps a reader's own answer over the turn's: a shut thought stays shut as the turn settles`, async () => {
        const element = mount({ thinking, live: true });
        nodes(element)[0]!.click();
        await settle();
        expect(shownText(element)).not.toContain(thinking);
    });
});
