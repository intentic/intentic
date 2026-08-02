// @vitest-environment jsdom
//
// The subject is what the panel BUILDS, which is the one thing that made the workspace unusable: a one-word
// query in a monorepo answers with a couple of thousand rows, the panel asked the highlighter to colour every
// one of them, the batch overflowed its LRU, and the rows that got evicted were re-requested by the very
// re-render their landing triggered — 1331 lines scheduled, then 731 rescheduled per round, forever, on the
// main thread with no yield. The tab took no further input. Nothing about that is visible in a composable
// test: it is a property of how many rows the component decides to build.
import type { WorkspaceSearchGroup } from "@intentic-app/api-contract";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

const tokenized = vi.hoisted(() => {
    const lines: string[] = [];
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    return lines;
});

// The real barrel, with the one function whose COST is the subject recorded instead of run. Grammar loading is
// what a mount cannot afford here; every call is a scheduled tokenize, which is exactly what is being counted.
vi.mock("@intentic/ui", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@intentic/ui")>();
    return {
        ...actual,
        useHighlighter: () => ({
            ...actual.useHighlighter(),
            tokenizeLine: async (line: string) => {
                tokenized.push(line);
                return undefined;
            },
        }),
    };
});

const { default: WorkspaceSearchResults } = await import("./WorkspaceSearchResults.vue");

// jsdom lays nothing out, so a scroller reports clientHeight 0 and the window would be empty whatever the
// component did. One viewport's worth of pixels is what makes the assertion about the component.
const VIEWPORT = 400;
Object.defineProperty(globalThis.HTMLElement.prototype, `clientHeight`, { configurable: true, get: () => VIEWPORT });

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    tokenized.length = 0;
});

const groupsOf = (files: number, hitsPerFile: number): WorkspaceSearchGroup[] =>
    Array.from({ length: files }, (_unused, file) => ({
        path: `pkg/module${file}/source${file}.ts`,
        score: 1,
        hits: Array.from({ length: hitsPerFile }, (_hit, hit) => ({
            line: hit + 1,
            text: `export const value${file}_${hit} = needle(${hit});`,
            spans: [{ start: 25, end: 31 }],
            tags: [{ kind: `text` as const }],
        })),
    }));

const mount = async (props: Partial<Record<string, unknown>> & { groups: readonly WorkspaceSearchGroup[] }): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        render: () =>
            h(WorkspaceSearchResults, {
                total: props.groups.reduce((sum, group) => sum + group.hits.length, 0),
                files: props.groups.length,
                partial: false,
                truncated: false,
                searching: false,
                pending: false,
                loadingMore: false,
                query: `needle`,
                ...props,
            }),
    });
    app.component(`Icon`, defineComponent({ props: { name: String, spin: Boolean }, render: () => h(`i`) }));
    app.mount(el);
    await nextTick();
    await nextTick();
    return el;
};

const rows = (el: HTMLElement): number => el.querySelectorAll(`[role="option"]`).length;

test(`a result set of thousands of rows costs a screenful of them`, async () => {
    const el = await mount({ groups: groupsOf(200, 30) });
    // 6,200 rows exist as far as the scrollbar and the count line are concerned...
    expect(el.textContent).toContain(`6,000 matches in 200 files`);
    expect(el.querySelector(`[role="listbox"] > div`)?.getAttribute(`style`)).toContain(`136400px`);
    // ...and a viewport's worth of them, plus overscan, are what actually got built and coloured. The number
    // that matters is that neither of these grows with the result set.
    expect(rows(el)).toBeLessThan(40);
    expect(tokenized.length).toBeLessThan(40);
});

test(`scrolling swaps the window instead of adding to it`, async () => {
    const el = await mount({ groups: groupsOf(200, 30) });
    const scroller = el.querySelector(`[role="listbox"]`) as HTMLElement;
    scroller.scrollTop = 40_000;
    scroller.dispatchEvent(new Event(`scroll`));
    await nextTick();
    expect(rows(el)).toBeLessThan(40);
    // The rows on screen are the ones at that offset, not the ones at the top.
    expect(el.textContent).not.toContain(`source0.ts`);
    // Two windows' worth of colour requested for two screenfuls looked at, and the LRU holds far more than
    // that — which is the whole reason nothing evicts under the render that asked for it.
    expect(tokenized.length).toBeLessThan(80);
});

test(`the count line says a total is a floor, and which file made it one`, async () => {
    const groups = groupsOf(1, 50);
    const el = await mount({ groups: [{ ...groups[0]!, capped: true }], total: 4_211, files: 87, partial: true });
    expect(el.textContent).toContain(`4,211+ matches in 87 files`);
    expect(el.textContent).toContain(`50+`);
});

test(`a truncated page offers the rest rather than implying there is none`, async () => {
    const el = await mount({ groups: groupsOf(2, 3), total: 900, files: 400, truncated: true });
    expect(el.textContent).toContain(`900 matches in 400 files · showing 6`);
    expect(el.textContent).toContain(`Show more matches`);
});
