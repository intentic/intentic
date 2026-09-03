// @vitest-environment jsdom
//
// The strip is what the workspace comes back as. Until it was persisted, a reload kept only the URL's one
// active file and dropped every other tab the session had opened, so this pins both halves: what a reload
// restores, and what a diff (the one kind too big and too stale to store) does to the focus that named it.
import { expect, it } from "vitest";
import { nextTick } from "vue";

// Both are read when the modules below load: the active sandbox keys the strip, and the strip is the state.
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
const { useEditBuffers } = await import("./useEditBuffers");
const { documentTabId } = await import("../../core-views/documentRegistry");

// The git graph, as the strip identifies it: an extension's document tab about the /work root. Composed the way
// the store composes it, so the tests pin the BEHAVIOUR rather than a spelling of the id.
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

// A diff carries both sides of the file as content and shows a comparison the agent has likely moved past by
// the next load, so it is never stored, and the focus it held lands on its last surviving neighbour rather
// than on a tab that won't be there.
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

// The close family's undo: a mis-closed tab comes back WHERE it was, which is what separates "reopen" from
// "open it again": a tab restored at the end of the strip would leave the user hunting for it.
it(`reopens the last closed tab at the position it held, and focuses it`, () => {
    closeTabIds(new Set(tabs.value.filter((tab) => tab.kind === `diff`).map((tab) => tab.id)));
    selectTab(`src/main.ts`);
    const before = tabs.value.map((tab) => tab.id);

    closeTabIds(new Set([`health:root`])); // the middle tab

    expect(tabs.value.map((tab) => tab.id)).toEqual([`src/main.ts`, `README.md`]);
    reopenClosedTab();

    expect(tabs.value.map((tab) => tab.id)).toEqual(before);
    expect(activeId.value).toBe(`health:root`);
    // The diff closed above is still on the stack, one entry below the graph tab just popped off it.
    expect(closedTabs.value).toHaveLength(1);
});

// One entry per CLOSE, so undoing a bulk close brings the whole strip back in order and in one press: the
// action the user took is the unit they undo.
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

/* The preview slot. Reading down the Changes list used to leave one pinned tab per file merely looked at, so a
 * row click now opens into a single slot that the next look takes over, and the gestures that mean "I want
 * this one" (a double-click on the tab or on the row) hand the tab over to the strip proper. */
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

// The other half of the same gesture: double-clicking the row re-opens the diff it is already previewing, and
// that second open is the one asking to keep it: one tab, no slot.
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

/* The same slot, for the gesture it was really needed for: browsing FILES. A click in the explorer used to pin a
 * tab per file glanced at, so a folder read top to bottom left a strip nobody could find anything in. */
it(`gives a peeked file the slot, and the next peek takes its place`, () => {
    const kept = tabs.value.map((tab) => tab.id);

    openFile(`src/peek-a.ts`, `preview`);

    expect(previewId.value).toBe(`src/peek-a.ts`);
    expect(tabs.value.map((tab) => tab.id)).toEqual([...kept, `src/peek-a.ts`]);

    openFile(`src/peek-b.ts`, `preview`);

    // In the outgoing preview's OWN position, so the slot stays put as the reader moves down the folder.
    expect(previewId.value).toBe(`src/peek-b.ts`);
    expect(tabs.value.map((tab) => tab.id)).toEqual([...kept, `src/peek-b.ts`]);
});

// The double-click on the row, and the one on the tab: the second, deliberate open is the one asking to keep it.
it(`keeps the peeked file when it is opened again to keep`, () => {
    openFile(`src/peek-b.ts`, `keep`);

    expect(previewId.value).toBeNull();
    expect(tabs.value.filter((tab) => tab.id === `src/peek-b.ts`)).toHaveLength(1);
});

// A tab the user chose to keep is never demoted by a later look at it: a peek at a file already open would
// otherwise hand its tab to the next peek and close the one they had deliberately pinned.
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

/* A replaced preview gives up what a closed tab gives up. The editor seeds from the buffer before the file it
 * re-reads, so a peek left behind would come back as the text the file had the FIRST time: stale the moment an
 * agent touched it, and written back over the newer file on the next save. */
it(`drops the replaced peek's text, so the file is re-read the next time it is opened`, () => {
    const { setBaseline, bufferOf } = useEditBuffers();
    openFile(`src/read-once.ts`, `preview`);
    setBaseline(`src/read-once.ts`, `on disk`);

    openFile(`src/read-next.ts`, `preview`);

    expect(bufferOf(`src/read-once.ts`)).toBeUndefined();
});

// The third promotion gesture, beside the two double-clicks: typing into a preview keeps it, so the next peek
// can never be what closes the user's own unsaved edit.
it(`keeps the previewed file the moment it is edited`, async () => {
    const { setBaseline, setBuffer } = useEditBuffers();
    openFile(`src/typed.ts`, `preview`);
    setBaseline(`src/typed.ts`, `before`);
    setBuffer(`src/typed.ts`, `after`);
    await nextTick();

    expect(previewId.value).toBeNull();
});

/* THE SPLIT. Reading a commit is a list and a diff, and in one pane they take turns: every file clicked in the
 * git graph replaced the graph that named it. So a diff asked for by a DOCUMENT opens in the companion pane. */
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

// The second file clicked arrives with the companion pane focused and a diff active, which is not a document,
// so it lands where the first one did: one companion tab, replaced as the reader moves down the file list.
it(`replaces the companion diff as the reader moves down the list`, () => {
    openDiff(diffPayload(`src/b.ts`), `preview`);

    const companion = strip.value.side.tabs[0];
    expect(strip.value.side.tabs).toHaveLength(1);
    expect(companion?.kind === `diff` ? companion.path : undefined).toBe(`src/b.ts`);
    expect(strip.value.main.tabs.map((tab) => tab.id)).toEqual([GIT_DOC]);
});

// Each pane owns a preview slot, so a peek in the companion cannot evict the document it was opened from.
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

// The explicit way in, for the pairings the store cannot guess: a README beside the code it describes.
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

// A phone, or a workspace column with no room for two readable halves: the diff opens where the reader is,
// exactly as it did before there were panes.
it(`opens a document's diff in place when a split is not allowed`, () => {
    startFresh();
    splitAllowed.value = false;
    openDocument(`git-history`, `log`, ``, `History`, `sitemap`);

    openDiff(diffPayload(`src/c.ts`), `preview`);

    expect(splitOpen.value).toBe(false);
    expect(strip.value.main.tabs.map((tab) => tab.kind)).toEqual([`document`, `diff`]);
});

// The room for two panes goes away (the chat opens, the window narrows). The tabs are the reader's place, so
// they fold back into one pane rather than being closed.
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

// A split of real files survives a reload; a split holding only a diff does not, because no diff is stored, and
// a restored empty column would be worse than the unsplit editor it comes back as.
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
