// @vitest-environment jsdom
// Pins what a reload restores from persisted tab state, and what happens to focus when the tab that held it
// (a diff) isn't stored.
import { expect, it } from "vitest";
import { nextTick } from "vue";

// Read at module load: the active sandbox id keys the strip's storage key.
const SANDBOX = `sb1`;
const KEY = `intentic.workspaceTabs.${SANDBOX}`;
localStorage.setItem(`intentic.activeSandboxId`, SANDBOX);
sessionStorage.setItem(
    KEY,
    JSON.stringify({
        active: `src/main.ts`,
        tabs: [
            { kind: `file`, id: `src/main.ts`, path: `src/main.ts` },
            { kind: `health`, id: `health:root`, repo: `root` },
        ],
    }),
);

const { useWorkspaceTabs } = await import("./useWorkspaceTabs");
const { useEditBuffers } = await import("../files/useEditBuffers");
const { documentTabId } = await import("../../../core-views/documentRegistry");

// Composed the same way the store composes it, so tests pin behaviour, not an id's exact spelling.
const GIT_DOC = documentTabId(`git-history`, `log`, ``);

const {
    tabs,
    activeId,
    previewId,
    openDiff,
    openFile,
    openDocument,
    keepTab,
    selectTab,
    closedTabs,
    closeTabIds,
    reopenClosedTab,
    strip,
    focusedPane,
    splitOpen,
    splitAllowed,
    openToSide,
    collapseSplit,
} = useWorkspaceTabs();
const diffPayload = (path: string) => ({
    key: `working:root`,
    scope: `root`,
    label: path,
    status: `modified` as const,
    path,
    before: `a`,
    after: `b`,
});
interface StoredPane {
    active: string | null;
    preview: string | null;
    tabs: { id: string }[];
}
const stored = (): StoredPane & { side?: StoredPane } => JSON.parse(sessionStorage.getItem(KEY) ?? `{}`);

it(`comes back with the tabs and focus the last visit left`, () => {
    expect(tabs.value.map((tab) => tab.id)).toEqual([`src/main.ts`, `health:root`]);
    expect(activeId.value).toBe(`src/main.ts`);
});

it(`persists an opened tab`, async () => {
    openFile(`README.md`);
    await nextTick();

    expect(stored().tabs.map((tab) => tab.id)).toEqual([`src/main.ts`, `health:root`, `README.md`]);
    expect(stored().active).toBe(`README.md`);
});

it(`leaves a diff out, and the focus it held with it`, async () => {
    openDiff(diffPayload(`src/main.ts`), `keep`);
    await nextTick();

    expect(tabs.value.some((tab) => tab.kind === `diff`)).toBe(true);
    expect(stored().tabs.map((tab) => tab.id)).toEqual([`src/main.ts`, `health:root`, `README.md`]);
    expect(stored().active).toBe(`README.md`);
});

it(`keeps a focus that was genuinely nothing`, async () => {
    selectTab(`src/main.ts`);
    activeId.value = null;
    await nextTick();

    expect(stored().active).toBeNull();
});

it(`reopens the last closed tab at the position it held, and focuses it`, () => {
    closeTabIds(new Set(tabs.value.filter((tab) => tab.kind === `diff`).map((tab) => tab.id)));
    selectTab(`src/main.ts`);
    const before = tabs.value.map((tab) => tab.id);

    closeTabIds(new Set([`health:root`])); // the middle tab

    expect(tabs.value.map((tab) => tab.id)).toEqual([`src/main.ts`, `README.md`]);
    reopenClosedTab();

    expect(tabs.value.map((tab) => tab.id)).toEqual(before);
    expect(activeId.value).toBe(`health:root`);
    // The diff closed above is still on the stack, one entry below what reopenClosedTab just popped off it.
    expect(closedTabs.value).toHaveLength(1);
});

it(`restores a whole bulk close in one press, in order and focused as it was`, () => {
    selectTab(`health:root`);
    closeTabIds(new Set(tabs.value.map((tab) => tab.id))); // Close All

    expect(tabs.value).toEqual([]);
    expect(activeId.value).toBeNull();

    reopenClosedTab();

    expect(tabs.value.map((tab) => tab.id)).toEqual([`src/main.ts`, `health:root`, `README.md`]);
    expect(activeId.value).toBe(`health:root`);
});

it(`does nothing when nothing has been closed`, () => {
    closedTabs.value = [];
    selectTab(`README.md`);

    reopenClosedTab();

    expect(tabs.value.map((tab) => tab.id)).toEqual([`src/main.ts`, `health:root`, `README.md`]);
    expect(activeId.value).toBe(`README.md`);
});

// Preview slot: a row click opens into one shared slot that the next look replaces; double-click (tab or row)
// hands it to the strip proper.
it(`replaces the previewed diff with the next one looked at, in its place`, () => {
    const kept = tabs.value.map((tab) => tab.id);

    openDiff(diffPayload(`src/a.ts`), `preview`);
    const first = activeId.value;

    expect(tabs.value.map((tab) => tab.id)).toEqual([...kept, first]);
    expect(previewId.value).toBe(first);

    openDiff(diffPayload(`src/b.ts`), `preview`);

    expect(tabs.value.map((tab) => tab.id)).toEqual([...kept, activeId.value]);
    expect(previewId.value).toBe(activeId.value);
});

it(`hands the tab over on a double-click, and previews the next one beside it`, () => {
    const promoted = activeId.value ?? ``;
    keepTab(promoted);

    expect(previewId.value).toBeNull();

    openDiff(diffPayload(`src/c.ts`), `preview`);

    expect(tabs.value.map((tab) => tab.id)).toEqual([`src/main.ts`, `health:root`, `README.md`, promoted, activeId.value]);
});

it(`releases the slot when the previewed row is re-opened to keep`, () => {
    openDiff(diffPayload(`src/c.ts`), `keep`);

    expect(previewId.value).toBeNull();
    expect(tabs.value.filter((tab) => tab.id === activeId.value)).toHaveLength(1);
});

it(`empties the slot when the preview tab is closed`, () => {
    openDiff(diffPayload(`src/d.ts`), `preview`);
    closeTabIds(new Set([previewId.value ?? ``]));

    expect(previewId.value).toBeNull();
});

// Same slot for browsing files: peeking one file takes over the slot from whichever file was peeked before.
it(`gives a peeked file the slot, and the next peek takes its place`, () => {
    const kept = tabs.value.map((tab) => tab.id);

    openFile(`src/peek-a.ts`, `preview`);

    expect(previewId.value).toBe(`src/peek-a.ts`);
    expect(tabs.value.map((tab) => tab.id)).toEqual([...kept, `src/peek-a.ts`]);

    openFile(`src/peek-b.ts`, `preview`);

    // Replaces at the outgoing preview's own position, so the slot doesn't move as peeks continue.
    expect(previewId.value).toBe(`src/peek-b.ts`);
    expect(tabs.value.map((tab) => tab.id)).toEqual([...kept, `src/peek-b.ts`]);
});

it(`keeps the peeked file when it is opened again to keep`, () => {
    openFile(`src/peek-b.ts`, `keep`);

    expect(previewId.value).toBeNull();
    expect(tabs.value.filter((tab) => tab.id === `src/peek-b.ts`)).toHaveLength(1);
});

it(`leaves an already-open tab where it stands when it is peeked at`, () => {
    openFile(`src/peek-c.ts`, `preview`);
    openFile(`src/peek-b.ts`, `preview`);

    expect(previewId.value).toBe(`src/peek-c.ts`);
    expect(activeId.value).toBe(`src/peek-b.ts`);
});

it(`stores the slot, so a session that ended mid-peek comes back mid-peek`, async () => {
    openFile(`src/peek-d.ts`, `preview`);
    await nextTick();

    expect(stored().preview).toBe(`src/peek-d.ts`);
});

// A stale buffer would seed the editor before the file re-reads, then overwrite it on save.
it(`drops the replaced peek's text, so the file is re-read the next time it is opened`, () => {
    const { setBaseline, bufferOf } = useEditBuffers();
    openFile(`src/read-once.ts`, `preview`);
    setBaseline(`src/read-once.ts`, `on disk`);

    openFile(`src/read-next.ts`, `preview`);

    expect(bufferOf(`src/read-once.ts`)).toBeUndefined();
});

// Third promotion gesture beside the two double-clicks: an edit must promote, or a peek could discard it.
it(`keeps the previewed file the moment it is edited`, async () => {
    const { setBaseline, setBuffer } = useEditBuffers();
    openFile(`src/typed.ts`, `preview`);
    setBaseline(`src/typed.ts`, `before`);
    setBuffer(`src/typed.ts`, `after`);
    await nextTick();

    expect(previewId.value).toBeNull();
});

// Split: a diff opened from a document tab (e.g. git graph) goes to the companion pane, so the document stays on
// screen instead of being replaced.
const startFresh = (): void => {
    closeTabIds(new Set([...strip.value.main.tabs, ...strip.value.side.tabs].map((tab) => tab.id)));
    closedTabs.value = [];
    splitAllowed.value = true;
};

it(`opens a document's diff beside it, leaving the document on screen`, () => {
    startFresh();
    openDocument(`git-history`, `log`, ``, `History`, `sitemap`);

    openDiff(diffPayload(`src/a.ts`), `preview`);

    expect(strip.value.main.tabs.map((tab) => tab.id)).toEqual([GIT_DOC]);
    expect(strip.value.main.active).toBe(GIT_DOC);
    expect(strip.value.side.tabs.map((tab) => tab.kind)).toEqual([`diff`]);
    expect(focusedPane.value).toBe(`side`);
    expect(splitOpen.value).toBe(true);
});

it(`replaces the companion diff as the reader moves down the list`, () => {
    openDiff(diffPayload(`src/b.ts`), `preview`);

    const companion = strip.value.side.tabs[0];
    expect(strip.value.side.tabs).toHaveLength(1);
    expect(companion?.kind === `diff` ? companion.path : undefined).toBe(`src/b.ts`);
    expect(strip.value.main.tabs.map((tab) => tab.id)).toEqual([GIT_DOC]);
});

it(`peeks in the companion pane without touching the main pane's slot`, () => {
    expect(strip.value.side.preview).toBe(strip.value.side.active);
    expect(strip.value.main.preview).toBeNull();
});

it(`ends the split when the companion's last tab is closed, and hands the focus back`, () => {
    closeTabIds(new Set(strip.value.side.tabs.map((tab) => tab.id)));

    expect(splitOpen.value).toBe(false);
    expect(focusedPane.value).toBe(`main`);
    expect(activeId.value).toBe(GIT_DOC);
});

// Explicit split for pairings the store can't guess, e.g. a README beside the code it describes.
it(`sends a tab to the side on request, and takes it back`, () => {
    startFresh();
    openFile(`src/left.ts`);
    openFile(`src/right.ts`);

    openToSide();

    expect(strip.value.main.tabs.map((tab) => tab.id)).toEqual([`src/left.ts`]);
    expect(strip.value.side.tabs.map((tab) => tab.id)).toEqual([`src/right.ts`]);
    expect(focusedPane.value).toBe(`side`);

    openToSide();

    expect(strip.value.main.tabs.map((tab) => tab.id)).toEqual([`src/left.ts`, `src/right.ts`]);
    expect(splitOpen.value).toBe(false);
});

// E.g. a phone, or a column too narrow for two readable halves.
it(`opens a document's diff in place when a split is not allowed`, () => {
    startFresh();
    splitAllowed.value = false;
    openDocument(`git-history`, `log`, ``, `History`, `sitemap`);

    openDiff(diffPayload(`src/c.ts`), `preview`);

    expect(splitOpen.value).toBe(false);
    expect(strip.value.main.tabs.map((tab) => tab.kind)).toEqual([`document`, `diff`]);
});

// E.g. the chat opens, or the window narrows.
it(`folds the companion pane back in when the room for two goes away`, () => {
    startFresh();
    openFile(`src/left.ts`);
    openFile(`src/right.ts`);
    openToSide();

    collapseSplit();

    expect(splitOpen.value).toBe(false);
    expect(strip.value.main.tabs.map((tab) => tab.id)).toEqual([`src/left.ts`, `src/right.ts`]);
    expect(activeId.value).toBe(`src/right.ts`);
});

it(`stores the companion pane, and stores nothing when it holds only a diff`, async () => {
    startFresh();
    openFile(`src/left.ts`);
    openFile(`src/right.ts`);
    openToSide();
    await nextTick();

    expect(stored().side?.tabs.map((tab) => tab.id)).toEqual([`src/right.ts`]);

    collapseSplit();
    openDocument(`git-history`, `log`, ``, `History`, `sitemap`);
    openDiff(diffPayload(`src/only-a-diff.ts`), `preview`);
    await nextTick();

    expect(splitOpen.value).toBe(true);
    expect(stored().side).toBeUndefined();
});
