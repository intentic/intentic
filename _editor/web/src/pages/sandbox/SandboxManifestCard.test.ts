// @vitest-environment jsdom
//
// jsdom because the subject is HOW MUCH IS ON SCREEN, and this card has been wrong about that twice: it opened
// with three sentences of preamble before naming the file, and it carried a "1 to fix" badge — a count of a list
// standing beside the list, alarming enough to notice and too vague to act on. Both read as fine in the source
// and as a block of amber text on the screen, which is what a rendered assertion is for.
import { STATE_DIR } from "@intentic/constants";
import type { ManifestProblemReport } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";

const reports = ref<ManifestProblemReport[]>([]);
vi.mock(`../../composables/sandbox/useManifestProblems`, () => ({
    useManifestProblems: () => ({ reports, hasProblems: computed(() => reports.value.length > 0) }),
}));

const opened = vi.fn();
vi.mock(`../../composables/workspace/openFileRef`, () => ({ openWorkspaceRef: (path: string) => opened(path) }));

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
    reports.value = [];
    document.body.replaceChildren();
});

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
    el.querySelector<HTMLElement>(`[aria-expanded="false"]`)?.click();
    await nextTick();

    const text = el.textContent ?? ``;
    expect(text).toContain(`It was written by intentic 1.233.0, newer than this sandbox (1.199.0).`);
    expect(text).toContain(`Update the sandbox — the file itself is probably fine.`);
});

it(`opens the file from its name, without opening the row`, () => {
    const el = mount([{ kind: `unknownKey`, detail: `skils`, suggestion: `skills` }]);
    const name = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`settings.json`));
    name?.click();
    // Every one of these ends with the file open in the editor; the name is the shortest way there. The full
    // path is what gets opened, and what a hover reports.
    expect(opened).toHaveBeenCalledWith(SETTINGS);
    expect(name?.title).toBe(SETTINGS);
});
