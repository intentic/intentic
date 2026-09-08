// @vitest-environment jsdom
// Pins render behavior of ChatToolRun: a run collapsed to one mark and count, and the same rows the shown mode
// draws once opened. Needs jsdom since both are render decisions, not throws.
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";

// Same runtime globals as ChatToolCard's suite (window.matchMedia, window.env), absent in jsdom.

const { default: ChatToolRun } = await import("./ChatToolRun.vue");

let app: App | undefined;
const mount = (tools: readonly TranscriptTool[], live = false): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatToolRun, { tools, live }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// Closing is a `<Transition>`, so calls leave with the reveal, not the tick that shut it; jsdom has no real
// duration, so this waits two animation frames instead of 160ms.
const settle = async (): Promise<void> => {
    await nextTick();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await nextTick();
};

let next = 0;
const tool = (over: Partial<TranscriptTool> & Pick<TranscriptTool, "category">): TranscriptTool => ({
    id: `t${(next += 1)}`,
    name: `Tool`,
    status: `completed`,
    ...over,
});
const read = (path: string): TranscriptTool => tool({ category: `read`, name: `Read`, target: path });
const edit = (path: string): TranscriptTool => tool({ category: `edit`, name: `Edit`, target: path });

describe(`ChatToolRun`, () => {
    it(`stands in for the whole run with a count and the most notable call's mark`, () => {
        const element = mount([read(`a.ts`), read(`b.ts`), edit(`c.ts`)]);
        const mark = element.querySelector(`button[aria-expanded]`);
        expect(mark?.textContent?.trim()).toBe(`3`);
        expect(mark?.querySelector(`[data-icon="file-edit"]`)).not.toBeNull();
        // Nothing of the calls themselves is on the page until it is opened.
        expect(element.textContent).not.toContain(`a.ts`);
    });

    it(`opens onto the calls themselves, and closes again`, async () => {
        const element = mount([read(`a.ts`), read(`b.ts`), edit(`c.ts`)]);
        const mark = element.querySelector<HTMLButtonElement>(`button[aria-expanded]`)!;
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
        expect(
            mount([read(`a.ts`)])
                .querySelector(`button`)
                ?.getAttribute(`aria-label`),
        ).toBe(`Show 1 step`);
        expect(
            mount([read(`a.ts`), read(`b.ts`)])
                .querySelector(`button`)
                ?.getAttribute(`aria-label`),
        ).toBe(`Show 2 steps`);
    });

    it(`spins while the turn is live, and only while it is live`, () => {
        const running = [read(`a.ts`), tool({ category: `execute`, name: `Bash`, status: `in_progress` })];
        expect(mount(running, true).querySelector(`[data-spin]`)).not.toBeNull();
        // Same run, replayed from history (live=false).
        expect(mount(running, false).querySelector(`[data-spin]`)).toBeNull();
    });

    it(`draws nothing at all for a turn that made no calls`, () => {
        expect(mount([]).querySelector(`button`)).toBeNull();
    });
});
