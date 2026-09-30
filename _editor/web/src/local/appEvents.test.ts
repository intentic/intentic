import "@intentic/testing/dom";
import { navigatedPath, openedPath } from "./appEvents";

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

/* The screen the app raised a window for: a route of the shell, or nothing. */
test("the app's navigate event names a route of the shell, and anything else names nothing", () => {
    const event = (detail: unknown): Event => new CustomEvent(`intentic:navigate`, { detail });
    expect([navigatedPath(event({ path: `/device` })), navigatedPath(event({ path: `device` })), navigatedPath(event(null)), navigatedPath(new Event(`intentic:navigate`))]).toEqual([
        `/device`,
        undefined,
        undefined,
        undefined,
    ]);
});
