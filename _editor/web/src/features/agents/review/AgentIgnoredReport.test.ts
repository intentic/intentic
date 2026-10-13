// jsdom because the subject is what each press hands back: one file from its own row, every listed file from the head.
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
// Each file as [path, what the row says of it], the path being the one monospaced span a row draws.
const rows = (el: HTMLElement): string[][] => [...el.querySelectorAll(`.font-mono`)].map((path) => [text(path), text(path.nextElementSibling)]);
const buttons = (el: HTMLElement, label: string): HTMLButtonElement[] =>
    [...el.querySelectorAll(`button`)].filter((button) => text(button) === label);

const IGNORED: readonly IgnoredGroup[] = [
    { repo: `video`, paths: [{ path: `out/warcry-9x16.mp4`, kind: `new`, bytes: 12_700_000 }], more: 3 },
    { repo: `root`, paths: [{ path: `renders/poster.png`, kind: `changed`, bytes: 2048 }] },
];

it(`says how many files the ignore rules kept out, names each with its size, and counts what is not listed`, async () => {
    const el = await mount(IGNORED);

    expect(text(el)).toContain(`This conversation also wrote 5 files your .gitignore excludes. They won't land on their own.`);
    expect(rows(el)).toEqual([
        [`video/out/warcry-9x16.mp4`, `new · 12 MB`],
        [`renders/poster.png`, `replaces a different one in your tree · 2.0 KB`],
    ]);
    expect(text(el)).toContain(`3 more not listed here`);
    expect(buttons(el, `Copy into my tree`)).toHaveLength(2);
    expect(buttons(el, `Copy all into my tree`)).toHaveLength(1);
});

it(`hands back one file from its row and every listed file, repo by repo, from copy all`, async () => {
    const emitted: unknown[][] = [];
    const el = await mount(IGNORED, emitted);

    buttons(el, `Copy into my tree`)[1]?.click();
    buttons(el, `Copy all into my tree`)[0]?.click();

    expect(emitted).toEqual([
        [{ repo: `root`, paths: [`renders/poster.png`] }],
        [
            { repo: `video`, paths: [`out/warcry-9x16.mp4`] },
            { repo: `root`, paths: [`renders/poster.png`] },
        ],
    ]);
});

it(`offers no copy all for a single file, and waits for a running turn, whose copy it would be reading`, async () => {
    const single = await mount([{ repo: `root`, paths: [{ path: `out/film.mp4`, kind: `new`, bytes: 10 }] }], [], true);

    expect(text(single)).toContain(`This conversation also wrote 1 file your .gitignore excludes. It won't land on its own.`);
    expect(buttons(single, `Copy all into my tree`)).toHaveLength(0);
    expect([...single.querySelectorAll(`button`)].every((button) => button.disabled)).toBe(true);
});
