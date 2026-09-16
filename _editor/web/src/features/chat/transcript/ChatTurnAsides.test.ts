// @vitest-environment jsdom
// Pins what an assistant turn leaves in the lane: a hidden run collapsed to one mark and count, a settled thought
// beside it on the same bar, and the same rows the shown mode draws once the run is opened. Needs jsdom since all of
// it is render behavior, not throws.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { useToolCalls } from "../tools/useToolCalls";

// Same runtime globals as ChatToolCard's suite (window.matchMedia, window.env), absent in jsdom.

const { default: ChatTurnAsides } = await import("./ChatTurnAsides.vue");

const { showToolCalls } = useToolCalls();

let app: App | undefined;
const mount = (props: { tools?: readonly TranscriptTool[]; thinking?: string; live?: boolean }): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatTurnAsides, { live: false, ...props }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

beforeEach(() => {
    // The preference is account-wide and persists across mounts; every case states the mode it is about.
    showToolCalls.value = false;
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

const marks = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`button[aria-expanded]`)];

let next = 0;
const tool = (over: Partial<TranscriptTool> & Pick<TranscriptTool, "category">): TranscriptTool => ({
    id: `t${(next += 1)}`,
    name: `Tool`,
    status: `completed`,
    ...over,
});
const read = (path: string): TranscriptTool => tool({ category: `read`, name: `Read`, target: path });
const edit = (path: string): TranscriptTool => tool({ category: `edit`, name: `Edit`, target: path });

describe(`ChatTurnAsides run mark`, () => {
    it(`stands in for the whole run with a count and the most notable call's mark`, () => {
        const element = mount({ tools: [read(`a.ts`), read(`b.ts`), edit(`c.ts`)] });
        const mark = marks(element)[0];
        expect(mark?.textContent?.trim()).toBe(`3`);
        expect(mark?.querySelector(`[data-icon="file-edit"]`)).not.toBeNull();
        // Nothing of the calls themselves is on the page until it is opened.
        expect(element.textContent).not.toContain(`a.ts`);
    });

    it(`opens onto the calls themselves, and closes again`, async () => {
        const element = mount({ tools: [read(`a.ts`), read(`b.ts`), edit(`c.ts`)] });
        const mark = marks(element)[0]!;
        expect(mark.getAttribute(`aria-expanded`)).toBe(`false`);

        mark.click();
        await nextTick();
        expect(mark.getAttribute(`aria-expanded`)).toBe(`true`);
        expect(element.textContent).toContain(`a.ts`);
        expect(element.textContent).toContain(`c.ts`);

        mark.click();
        await settle();
        // Dropped from the DOM, not merely hidden.
        expect(element.textContent).not.toContain(`a.ts`);
        expect(mark.getAttribute(`aria-expanded`)).toBe(`false`);
    });

    it(`says how many steps it is offering, for the pointer and the screen reader alike`, () => {
        expect(marks(mount({ tools: [read(`a.ts`)] }))[0]?.getAttribute(`aria-label`)).toBe(`Show 1 step`);
        expect(marks(mount({ tools: [read(`a.ts`), read(`b.ts`)] }))[0]?.getAttribute(`aria-label`)).toBe(`Show 2 steps`);
    });

    it(`spins while the turn is live, and only while it is live`, () => {
        const running = [read(`a.ts`), tool({ category: `execute`, name: `Bash`, status: `in_progress` })];
        expect(mount({ tools: running, live: true }).querySelector(`[data-spin]`)).not.toBeNull();
        // Same run, replayed from history (live=false).
        expect(mount({ tools: running, live: false }).querySelector(`[data-spin]`)).toBeNull();
    });

    it(`draws nothing at all for a turn that made no calls and thought nothing`, () => {
        expect(mount({ tools: [] }).querySelector(`button`)).toBeNull();
    });

    it(`draws the calls as rows, and leaves no mark, for a reader who asked to see them`, () => {
        showToolCalls.value = true;
        const element = mount({ tools: [read(`a.ts`), edit(`c.ts`)] });

        expect(marks(element)).toHaveLength(0);
        expect(element.textContent).toContain(`a.ts`);
        expect(element.textContent).toContain(`c.ts`);
    });
});

// Thinking and a hidden run belong to one row, so they share one bar: two bars would put their marks half a line
// apart out in the lane, on top of each other.
describe(`ChatTurnAsides thinking mark`, () => {
    const thinking = `The tile already renders a status dot, so the badge should reuse that lane.`;

    it(`stands beside the run's mark on one bar, and opens instead of it`, async () => {
        const element = mount({ thinking, tools: [read(`a.ts`)] });

        expect(element.querySelectorAll(`.chat-mark-bar`)).toHaveLength(1);
        const [thought, run] = marks(element);
        expect(thought?.getAttribute(`aria-label`)).toBe(`Thinking`);
        expect(run?.getAttribute(`aria-label`)).toBe(`Show 1 step`);
        expect(element.textContent).not.toContain(thinking);

        thought!.click();
        await nextTick();
        expect(element.textContent).toContain(thinking);

        // One body under one bar: opening the run puts the thought away.
        run!.click();
        await nextTick();
        expect(element.textContent).not.toContain(thinking);
        expect(element.textContent).toContain(`a.ts`);
    });

    it(`reads as it is written and puts itself away once the turn lands`, async () => {
        const live = mount({ thinking, live: true });
        expect(live.textContent).toContain(thinking);
        expect(live.querySelector(`[data-spin]`)).not.toBeNull();

        app?.unmount();
        app = undefined;
        document.body.innerHTML = ``;

        const settled = mount({ thinking, live: false });
        expect(settled.textContent).not.toContain(thinking);
        expect(marks(settled)[0]?.querySelector(`[data-icon="sparkles"]`)).not.toBeNull();
    });

    it(`keeps a reader's own answer over the turn's: a shut thought stays shut as the turn settles`, async () => {
        const element = mount({ thinking, live: true });
        marks(element)[0]!.click();
        await settle();
        expect(element.textContent).not.toContain(thinking);
    });
});
