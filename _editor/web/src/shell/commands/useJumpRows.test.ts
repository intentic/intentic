import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { computed, effectScope, type Ref, ref } from "vue";

// Pins the palette a local window opens on Ctrl/Cmd+P: its files alone, each opened by the window rather than by a route,
// and the whole query read as a file's name, since there is no other kind to narrow to. The file search itself is the
// seam (useFuzzyFiles), answering two paths for any query it is given.

jest.mock("../../features/workspace/search/useFuzzyFiles", () => ({
    useFuzzyFiles: (query: Ref<string>, active: Ref<boolean>) => ({
        paths: computed(() => (active.value && query.value.length >= 1 ? [`src/app.ts`, `docs/apple.md`] : [])),
        floor: computed(() => 1),
        searching: computed(() => false),
        pending: computed(() => false),
        truncated: computed(() => false),
        error: computed(() => undefined),
    }),
}));

const { useFileJumpRows } = await import("./useJumpRows");
const { useWorkspaceTabs } = await import("../../features/workspace/tabs/useWorkspaceTabs");

afterEach(() => resetSandboxScope());

const palette = (query: Ref<string>) => {
    const opened: string[] = [];
    const rows = effectScope().run(() => useFileJumpRows(query, ref(true), (path) => opened.push(path)));
    if (rows === undefined) {
        throw new Error(`the palette was not set up`);
    }
    return { ...rows, opened };
};

test("with nothing typed it lists the open files, and a query lists the folder's matches, opened by the window", () => {
    useWorkspaceTabs().openFile(`notes/plan.md`, `keep`);
    const query = ref(``);
    const { sections, rows, opened } = palette(query);
    const listed = sections.value.map((section) => [section.heading, section.rows.map((row) => row.title)]);
    query.value = `app`;
    const matched = sections.value.map((section) => [section.heading, section.rows.map((row) => [row.title, row.detail])]);
    rows.value[1]?.run();
    expect([listed, matched, opened]).toEqual([
        [[`Recently opened`, [`plan.md`]]],
        [
            [
                `Files`,
                [
                    [`app.ts`, `src`],
                    [`apple.md`, `docs`],
                ],
            ],
        ],
        [`docs/apple.md`],
    ]);
});

test("a prefix narrows nothing: the whole query is the file's name", () => {
    const { parsed } = palette(ref(`> app`));
    expect(parsed.value).toEqual({ kind: `file`, text: `> app` });
});
