// @vitest-environment jsdom
//
// The strip is what the workspace comes back as. Until it was persisted, a reload kept only the URL's one
// active file and dropped every other tab the session had opened — so this pins both halves: what a reload
// restores, and what a diff (the one kind too big and too stale to store) does to the focus that named it.
import { expect, it, vi } from "vitest";
import { nextTick } from "vue";

vi.hoisted(() => {
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

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

const { tabs, activeId, previewId, openDiff, openFile, keepTab, selectTab, closedTabs, closeTabIds, reopenClosedTab } = useWorkspaceTabs();
const diffPayload = (path: string) => ({
    key: `working:root`,
    scope: `root`,
    label: path,
    status: `modified` as const,
    path,
    before: `a`,
    after: `b`,
});
const stored = (): { active: string | null; tabs: { id: string }[] } => JSON.parse(sessionStorage.getItem(KEY) ?? `{}`);

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
// the next load, so it is never stored — and the focus it held lands on its last surviving neighbour rather
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
// "open it again" — a tab restored at the end of the strip would leave the user hunting for it.
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

// One entry per CLOSE, so undoing a bulk close brings the whole strip back in order and in one press — the
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
 * row click now opens into a single slot that the next look takes over — and the gestures that mean "I want
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
// that second open is the one asking to keep it — one tab, no slot.
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
