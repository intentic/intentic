// @vitest-environment jsdom
// Pins that a collapsed row shows only a file name and a status tag, no preamble or complaint count.
// jsdom: mounts the component tree and reads rendered text.
import { STATE_DIR } from "@intentic/constants";
import type { ManifestProblemReport, ManifestRepair } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const reports = ref<ManifestProblemReport[]>([]);
const repair = vi.fn<(request: ManifestRepair) => Promise<void>>(async () => undefined);
vi.mock(`../extensions/useManifestProblems`, () => ({
    useManifestProblems: () => ({ reports, hasProblems: computed(() => reports.value.length > 0), repair }),
}));

const opened = vi.fn();
vi.mock(`../../workspace/files/openFileRef`, () => ({ openWorkspaceRef: (path: string) => opened(path) }));

const { default: SandboxManifestCard } = await import("./SandboxManifestCard.vue");

const SETTINGS = `${STATE_DIR}/config/settings.json`;
const SKEW: ManifestProblemReport[`problems`] = [
    {
        kind: `unreadable`,
        detail: `it was written by intentic 1.233.0, newer than this sandbox (1.199.0)`,
        fix: `Update the sandbox — the file itself is probably fine.`,
    },
];

let app: App | undefined;

const mount = (problems: ManifestProblemReport[`problems`]): HTMLElement => {
    reports.value = problems.length === 0 ? [] : [{ path: SETTINGS, problems }];
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxManifestCard) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    opened.mockReset();
    repair.mockClear();
    reports.value = [];
    document.body.replaceChildren();
});

// Opens the row via its chevron; the diagnosis and buttons only exist once it's open.
const open = async (el: HTMLElement): Promise<void> => {
    el.querySelector<HTMLElement>(`[aria-expanded="false"]`)?.click();
    await nextTick();
};

const pressable = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === label);

it(`says nothing while every manifest reads clean`, () => {
    expect(mount([]).textContent?.trim()).toBe(``);
});

it(`is a name and a tag until somebody asks for more`, () => {
    const text = mount(SKEW).textContent ?? ``;

    expect(text).toContain(`settings.json`);
    expect(text).toContain(`using defaults`);
    expect(text).not.toContain(`${STATE_DIR}/config/settings.json`);
    expect(text).not.toContain(`1.233.0`);
    expect(text).not.toContain(`Update the sandbox`);
    expect(text).not.toMatch(/to fix/i);
    expect(text).not.toMatch(/couldn't make sense/i);
});

it(`opens into the cause and the one instruction`, async () => {
    const el = mount(SKEW);
    await open(el);

    const text = el.textContent ?? ``;
    expect(text).toContain(`It was written by intentic 1.233.0, newer than this sandbox (1.199.0).`);
    expect(text).toContain(`Update the sandbox — the file itself is probably fine.`);
});

it(`opens the file from its name, without opening the row`, () => {
    const el = mount([{ kind: `unknownKey`, detail: `skils`, suggestion: `skills` }]);
    const name = [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.includes(`settings.json`));
    name?.click();
    expect(opened).toHaveBeenCalledWith(SETTINGS);
    expect(name?.title).toBe(SETTINGS);
});

it(`keeps the repair behind the chevron, like everything else on the row`, () => {
    const el = mount([{ kind: `unknownKey`, detail: `contextShelf` }]);
    expect(pressable(el, `Remove it`)).toBeUndefined();
});

it(`takes the stray key out from the row itself`, async () => {
    const el = mount([{ kind: `unknownKey`, detail: `contextShelf` }]);
    await open(el);

    pressable(el, `Remove it`)?.click();
    expect(repair).toHaveBeenCalledWith({ path: SETTINGS, key: `contextShelf` });
});

it(`sends the guess as a rename, carrying the value across`, async () => {
    const el = mount([{ kind: `unknownKey`, detail: `skils`, suggestion: `skills` }]);
    await open(el);

    pressable(el, `Rename it`)?.click();
    expect(repair).toHaveBeenCalledWith({ path: SETTINGS, key: `skils`, to: `skills` });
});

it(`says why a repair did not happen, where it was asked for`, async () => {
    repair.mockRejectedValueOnce(new Error(`"contextShelf" is not in .intentic/config/settings.json any more`));
    const el = mount([{ kind: `unknownKey`, detail: `contextShelf` }]);
    await open(el);

    pressable(el, `Remove it`)?.click();
    await nextTick();
    await nextTick();
    expect(el.textContent).toContain(`Couldn't remove "contextShelf".`);
});

it(`says nothing at all when a repair works`, async () => {
    const el = mount([{ kind: `unknownKey`, detail: `contextShelf` }]);
    await open(el);

    pressable(el, `Remove it`)?.click();
    await nextTick();
    await nextTick();
    expect(repair).toHaveBeenCalledTimes(1);
    expect(el.textContent).not.toMatch(/couldn't/i);
});
