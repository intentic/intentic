// jsdom because the subject is what each press hands back, what the folded line says, and which rows a folder of many
// folds into.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { IgnoredGroup } from "./AgentIgnoredReport.vue";

const { default: AgentIgnoredReport } = await import("./AgentIgnoredReport.vue");

let app: App | undefined;
let host: HTMLElement | undefined;

const mount = async (ignored: readonly IgnoredGroup[], emitted: unknown[][] = [], streaming = false): Promise<HTMLElement> => {
    host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({
        render: () =>
            h(AgentIgnoredReport, {
                ignored,
                busy: false,
                streaming,
                onCopy: (groups: { repo: string; paths: string[] }[]) => emitted.push(groups),
            }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    await nextTick();
    return host;
};

afterEach(() => {
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;
});

const text = (el: Element | null): string => (el?.textContent ?? ``).replace(/\s+/g, ` `).trim();
// A row as it reads, one piece per text node: the compiler drops the whitespace between a row's elements.
const words = (el: Element): string => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const pieces: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        pieces.push(node.textContent ?? ``);
    }
    return pieces.join(` `).replace(/\s+/g, ` `).trim();
};
// Each top-level row, its button's words included.
const rows = (el: HTMLElement): string[] => [...el.querySelectorAll(`section > ul > li`)].map((row) => words(row));
// Opens the list folded under the line.
const show = async (el: HTMLElement): Promise<void> => {
    el.querySelector<HTMLButtonElement>(`header [aria-expanded]`)?.click();
    await nextTick();
};
const buttons = (el: HTMLElement, label: string): HTMLButtonElement[] =>
    [...el.querySelectorAll(`button`)].filter((button) => text(button) === label);

const IGNORED: readonly IgnoredGroup[] = [
    { repo: `video`, paths: [{ path: `out/warcry-9x16.mp4`, kind: `new`, bytes: 12_700_000 }], more: 3 },
    { repo: `root`, paths: [{ path: `renders/poster.png`, kind: `changed`, bytes: 2048 }] },
];

it(`says what won't land and how much on one folded line, and opened names each file by its name and folder, flagging only one it would replace`, async () => {
    const el = await mount(IGNORED);

    expect(text(el.querySelector(`header`))).toContain(`Won't land: 5 files your .gitignore excludes · 12 MB`);
    expect(rows(el)).toEqual([]);
    expect(buttons(el, `Copy all into my tree`)).toHaveLength(1);

    await show(el);
    expect(rows(el)).toEqual([
        `warcry-9x16.mp4 video/out 12 MB Copy`,
        `poster.png renders replaces yours 2.0 KB Copy`,
        `3 more not listed here`,
    ]);
    expect(buttons(el, `Copy`)).toHaveLength(2);
    expect(buttons(el, `Copy all into my tree`)).toHaveLength(1);
});

it(`hands back one file from its row and every listed file, repo by repo, from copy all`, async () => {
    const emitted: unknown[][] = [];
    const el = await mount(IGNORED, emitted);
    await show(el);

    buttons(el, `Copy`)[1]?.click();
    buttons(el, `Copy all into my tree`)[0]?.click();

    expect(emitted).toEqual([
        [{ repo: `root`, paths: [`renders/poster.png`] }],
        [
            { repo: `video`, paths: [`out/warcry-9x16.mp4`] },
            { repo: `root`, paths: [`renders/poster.png`] },
        ],
    ]);
});

it(`folds a folder of many into one row that copies them all and opens onto them`, async () => {
    const frames = Array.from({ length: 5 }, (_, index) => ({ path: `out/frames/f${index}.png`, kind: `new` as const, bytes: 1024 }));
    const emitted: unknown[][] = [];
    const el = await mount([{ repo: `root`, paths: [{ path: `out/film.mp4`, kind: `new`, bytes: 10 }, ...frames] }], emitted);
    await show(el);

    expect(rows(el)).toEqual([`film.mp4 out 10 B Copy`, `frames out 5 files 5.0 KB Copy`]);

    buttons(el, `Copy`)[1]?.click();
    expect(emitted).toEqual([[{ repo: `root`, paths: frames.map((frame) => frame.path) }]]);

    el.querySelector<HTMLButtonElement>(`ul [aria-expanded]`)?.click();
    await nextTick();
    expect([...el.querySelectorAll(`section > ul > li > ul > li`)].map((row) => words(row))).toEqual(
        frames.map((frame) => `${frame.path.slice(`out/frames/`.length)} 1.0 KB Copy`),
    );
});

it(`offers a lone file's copy from the line in the singular`, async () => {
    const emitted: unknown[][] = [];
    const single = await mount([{ repo: `root`, paths: [{ path: `out/film.mp4`, kind: `new`, bytes: 10 }] }], emitted);

    expect(text(single.querySelector(`header`))).toContain(`Won't land: 1 file your .gitignore excludes`);
    expect(buttons(single, `Copy all into my tree`)).toHaveLength(0);
    buttons(single, `Copy into my tree`)[0]?.click();
    expect(emitted).toEqual([[{ repo: `root`, paths: [`out/film.mp4`] }]]);
});

it(`waits for a running turn, whose copy it would be reading, while still letting the list open`, async () => {
    const el = await mount(IGNORED, [], true);

    expect(text(el.querySelector(`header`))).toContain(`Copy once this turn ends`);
    expect(buttons(el, `Copy all into my tree`)).toHaveLength(0);
    await show(el);
    expect(buttons(el, `Copy`).every((button) => button.disabled)).toBe(true);
    expect(buttons(el, `Hide`).map((button) => button.disabled)).toEqual([false]);
});
