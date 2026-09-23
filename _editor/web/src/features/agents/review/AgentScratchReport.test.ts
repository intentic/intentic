// jsdom because the subject is which rows offer which way out: a checkout of its own can only ever leave.
import "@intentic/testing/dom";
import type { ScratchPath } from "@intentic/sandbox-contract";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

const { default: AgentScratchReport } = await import("./AgentScratchReport.vue");

let app: App | undefined;
let host: HTMLElement | undefined;

type Scratch = readonly { readonly repo: string; readonly paths: readonly ScratchPath[] }[];

const mount = async (scratch: Scratch, emitted: unknown[][] = [], streaming = false): Promise<HTMLElement> => {
    host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({
        render: () =>
            h(AgentScratchReport, {
                scratch,
                busy: false,
                streaming,
                onInclude: (repo: string, paths: string[]) => emitted.push([`include`, repo, paths]),
                onDelete: (repo: string, paths: string[]) => emitted.push([`delete`, repo, paths]),
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

const text = (el: HTMLElement): string => (el.textContent ?? ``).replace(/\s+/g, ` `).trim();
// Each entry as [path, what the row says of it], the path being the one monospaced span a row draws.
const rows = (el: HTMLElement): string[][] =>
    [...el.querySelectorAll(`.font-mono`)].map((path) => [text(path as HTMLElement), text(path.nextElementSibling as HTMLElement)]);
const buttons = (el: HTMLElement, label: string): HTMLButtonElement[] =>
    [...el.querySelectorAll(`button`)].filter((button) => (button.textContent ?? ``).includes(label));

const SCRATCH: Scratch = [
    { repo: `root`, paths: [{ path: `.trun/`, reason: `hidden`, files: 84, bytes: 1_150_000 }] },
    { repo: `intentic`, paths: [{ path: `src/debug.log`, reason: `byproduct`, files: 1, bytes: 512 }] },
    { repo: `root`, paths: [{ path: `newrepo/`, reason: `checkout` }] },
];

it(`names every entry under its repo with why and how much, and offers include only where a land could carry it`, async () => {
    const el = await mount(SCRATCH);

    expect(text(el)).toContain(`3 paths left out of the land as scratch`);
    expect(rows(el)).toEqual([
        [`.trun/`, `a new hidden folder · 84 files, 1.1 MB`],
        [`intentic/src/debug.log`, `a log, dump or backup · 1 file, 512 B`],
        [`newrepo/`, `a checkout of its own, which no land can carry`],
    ]);
    expect(buttons(el, `Include`)).toHaveLength(2);
    expect(buttons(el, `Delete`)).toHaveLength(3);
});

it(`hands back the repo and the path exactly as listed`, async () => {
    const emitted: unknown[][] = [];
    const el = await mount(SCRATCH, emitted);

    buttons(el, `Include`)[1]?.click();
    buttons(el, `Delete`)[2]?.click();

    expect(emitted).toEqual([
        [`include`, `intentic`, [`src/debug.log`]],
        [`delete`, `root`, [`newrepo/`]],
    ]);
});

it(`waits for a running turn, whose copy it would be reaching into`, async () => {
    const el = await mount(SCRATCH, [], true);

    expect([...el.querySelectorAll(`button`)].every((button) => button.disabled)).toBe(true);
});
