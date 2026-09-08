// @vitest-environment jsdom
// Pins that the panel's build cost (rows rendered, lines tokenized) doesn't scale with result count; a
// composable test can't see this, since it's a property of how many rows the component builds.
import type { WorkspaceSearchGroup } from "@intentic/api-contract";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

const tokenized = vi.hoisted(() => {
    const lines: string[] = [];
    return lines;
});

// The real barrel, with only tokenizeLine recording its cost instead of running it, since grammar loading is
// what a mount can't afford; every call is a scheduled tokenize, exactly what's counted.
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

// jsdom lays nothing out, so a real scroller reports clientHeight 0; stubbing one viewport of pixels is what
// makes the assertion about the component, not jsdom.
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
    app.component(`Icon`, IconStub);
    app.mount(el);
    await nextTick();
    await nextTick();
    return el;
};

const rows = (el: HTMLElement): number => el.querySelectorAll(`[role="option"]`).length;

test(`a result set of thousands of rows costs a screenful of them`, async () => {
    const groups = groupsOf(200, 30);
    const total = groups.reduce((sum, group) => sum + group.hits.length, 0);
    const el = await mount({ groups });
    expect(el.textContent).toContain(total.toLocaleString(`en-US`));
    expect(el.textContent).toContain(String(groups.length));
    expect(el.querySelector(`[role="listbox"] > div`)?.getAttribute(`style`)).toContain(`136400px`);
    // A viewport's worth, plus overscan, is what gets built; neither count grows with the result set.
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
    // Two windows of colour for two screenfuls; the LRU holds far more, so nothing evicts under this render.
    expect(tokenized.length).toBeLessThan(80);
});

// Both totals are floors when the search says so, since the same scan ceiling bounds both; a "+" with a bare
// file count would wrongly imply an exact one.
test(`the count line says both totals are floors, and which file made the matches one`, async () => {
    const groups = groupsOf(1, 50);
    const el = await mount({ groups: [{ ...groups[0]!, capped: true }], total: 4_211, files: 87, partial: true });
    expect(el.textContent).toContain(`4,211`);
    expect(el.textContent).toContain(`87`);
    expect(el.textContent).toContain(`50`);
    expect(el.textContent).toMatch(/\+/);
});

test(`a truncated page offers the rest rather than implying there is none`, async () => {
    const groups = groupsOf(2, 3);
    const shown = groups.reduce((sum, group) => sum + group.hits.length, 0);
    const el = await mount({ groups, total: 900, files: 400, truncated: true });
    expect(el.textContent).toContain(`900`);
    expect(el.textContent).toContain(`400`);
    expect(el.textContent).toContain(String(shown));
    expect(el.querySelector(`button`)).not.toBeNull();
});
