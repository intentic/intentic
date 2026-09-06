// @vitest-environment jsdom
//
// jsdom because the subject is HOW MUCH IS ON SCREEN, and this card has been wrong about that twice: it opened
// with three sentences of preamble before naming the file, and it carried a "1 to fix" badge — a count of a list
// standing beside the list, alarming enough to notice and too vague to act on. Both read as fine in the source
// and as a block of amber text on the screen, which is what a rendered assertion is for.
import { STATE_DIR } from "@intentic/constants";
import type { ManifestProblemReport, ManifestRepair } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";

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
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
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

// The row's own chevron. Every assertion about the opened state goes through it, because the diagnosis and the
// buttons are deliberately behind it: a collapsed row is a name and a tag and nothing else.
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

    // The whole default state: which file, how bad. Not the directory it shares with every other reported
    // manifest, not the diagnosis, not the instruction, and not a count of complaints.
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
    // The remaining way out for everything a button can't do: the file, in the editor. The full path is what
    // gets opened, and what a hover reports.
    expect(opened).toHaveBeenCalledWith(SETTINGS);
    expect(name?.title).toBe(SETTINGS);
});

it(`keeps the repair behind the chevron, like everything else on the row`, () => {
    // The buttons are detail. A card that showed them collapsed would be offering an irreversible-looking
    // action to somebody who has not yet read which key it is about.
    const el = mount([{ kind: `unknownKey`, detail: `contextShelf` }]);
    expect(pressable(el, `Remove it`)).toBeUndefined();
});

it(`takes the stray key out from the row itself`, async () => {
    const el = mount([{ kind: `unknownKey`, detail: `contextShelf` }]);
    await open(el);

    pressable(el, `Remove it`)?.click();
    // No `to`: a removal, of exactly the key the line named, in the file the row is titled with.
    expect(repair).toHaveBeenCalledWith({ path: SETTINGS, key: `contextShelf` });
});

it(`sends the guess as a rename, carrying the value across`, async () => {
    const el = mount([{ kind: `unknownKey`, detail: `skils`, suggestion: `skills` }]);
    await open(el);

    pressable(el, `Rename it`)?.click();
    expect(repair).toHaveBeenCalledWith({ path: SETTINGS, key: `skils`, to: `skills` });
});

it(`says why a repair did not happen, where it was asked for`, async () => {
    // The daemon's refusals are races with the reader's own editor ("already fixed"), and a button that
    // visibly does nothing is the exact failure this card exists to report.
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
    // The row going away IS the confirmation: the write moves the file, the watcher invalidates, the daemon
    // re-reads. A success banner would announce something the reader is already watching happen.
    expect(repair).toHaveBeenCalledTimes(1);
    expect(el.textContent).not.toMatch(/couldn't/i);
});
