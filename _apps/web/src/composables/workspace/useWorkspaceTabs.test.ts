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
            { kind: `graph`, id: `graph:root`, repo: `root` },
        ],
    }),
);

const { useWorkspaceTabs } = await import("./useWorkspaceTabs");

const { tabs, activeId, openDiff, openFile, selectTab } = useWorkspaceTabs();
const stored = (): { active: string | null; tabs: { id: string }[] } => JSON.parse(sessionStorage.getItem(KEY) ?? `{}`);

it(`comes back with the tabs and focus the last visit left`, () => {
    expect(tabs.value.map((tab) => tab.id)).toEqual([`src/main.ts`, `graph:root`]);
    expect(activeId.value).toBe(`src/main.ts`);
});

it(`persists an opened tab`, async () => {
    openFile(`README.md`);
    await nextTick();

    expect(stored().tabs.map((tab) => tab.id)).toEqual([`src/main.ts`, `graph:root`, `README.md`]);
    expect(stored().active).toBe(`README.md`);
});

// A diff carries both sides of the file as content and shows a comparison the agent has likely moved past by
// the next load, so it is never stored — and the focus it held lands on its last surviving neighbour rather
// than on a tab that won't be there.
it(`leaves a diff out, and the focus it held with it`, async () => {
    openDiff({ key: `working:root`, scope: `root`, label: `main.ts`, status: `modified`, path: `src/main.ts`, before: `a`, after: `b` });
    await nextTick();

    expect(tabs.value.some((tab) => tab.kind === `diff`)).toBe(true);
    expect(stored().tabs.map((tab) => tab.id)).toEqual([`src/main.ts`, `graph:root`, `README.md`]);
    expect(stored().active).toBe(`README.md`);
});

it(`keeps a focus that was genuinely nothing`, async () => {
    selectTab(`src/main.ts`);
    activeId.value = null;
    await nextTick();

    expect(stored().active).toBeNull();
});
