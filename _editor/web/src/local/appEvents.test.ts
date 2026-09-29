import "@intentic/testing/dom";
import { openedPath } from "./appEvents";

// Pins what a local window reads off the app's `intentic:open`: the entry to open, relative to its folder, or nothing.

test("an entry of the window's folder is read off the event, and any other shape is nothing", () => {
    const opened = (detail: unknown): string | undefined => openedPath(new CustomEvent(`intentic:open`, { detail }));
    expect([
        opened({ path: `docs/a b.md` }),
        opened({ path: `` }),
        opened({ path: 7 }),
        opened({ file: `docs/a.md` }),
        opened(`docs/a.md`),
        opened(undefined),
        openedPath(new Event(`intentic:open`)),
    ]).toEqual([`docs/a b.md`, undefined, undefined, undefined, undefined, undefined, undefined]);
});
