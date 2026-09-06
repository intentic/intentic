// @vitest-environment jsdom
//
// jsdom because what this component IS is what it renders: a turn's whole run of tool calls reduced to one
// mark, and the same rows the shown mode draws once that mark is opened. Both halves are render decisions:
// neither throws when it goes wrong, it just draws the wrong thing.
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";

// Same runtime globals ChatToolCard's suite stands up, and for the same reason: the import chain reads
// window.matchMedia and window.env at module load, and jsdom provides neither.

const { default: ChatToolRun } = await import("./ChatToolRun.vue");

let app: App | undefined;
const mount = (tools: readonly TranscriptTool[], live = false): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatToolRun, { tools, live }) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name, class: this.spin ? `animate-spin` : undefined });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

/* Closing a run is a <Transition>, so the calls leave with the reveal rather than on the tick that shut it:
 * they are gone once it has run, which is what "closed" means to a reader. jsdom reports no transition
 * duration, so Vue finishes the leave on the next frames rather than after any real 160ms. */
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
        // Dropped, not merely hidden: a transcript holds hundreds of runs and a closed one costs no DOM.
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
        expect(mount(running, true).querySelector(`.animate-spin`)).not.toBeNull();
        // The same frozen run, replayed from history: a mark that kept spinning would claim it is still going.
        expect(mount(running, false).querySelector(`.animate-spin`)).toBeNull();
    });

    it(`draws nothing at all for a turn that made no calls`, () => {
        expect(mount([]).querySelector(`button`)).toBeNull();
    });
});
