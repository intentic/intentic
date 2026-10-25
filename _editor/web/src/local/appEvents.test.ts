import "@intentic/testing/dom";
import { heldAnew, navigatedPath, openedPath, openingStage } from "./appEvents";

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

/* How far the folder's sandbox has come, as the app says it after "Open this folder's sandbox". */
test("the opening event names a stage the button knows, and anything else names nothing", () => {
    const event = (detail: unknown): Event => new CustomEvent(`intentic:sandbox-opening`, { detail });
    expect([
        openingStage(event({ stage: `starting` })),
        openingStage(event({ stage: `shown` })),
        openingStage(event({ stage: `opening` })),
        openingStage(event(null)),
        openingStage(new Event(`intentic:sandbox-opening`)),
    ]).toEqual([`starting`, `shown`, undefined, undefined, undefined]);
});

/* Whose the folder's sandbox is after an account changed (the app's local.rs `face_held`). */
test("the holder event says whose the folder's sandbox is now, and anything else says nothing", () => {
    const event = (detail: unknown): Event => new CustomEvent(`intentic:holder`, { detail });
    expect([
        heldAnew(event({ sandbox: false, otherAccount: true, owner: `ada@work.example` })),
        heldAnew(event({ sandbox: true, otherAccount: false, owner: null })),
        heldAnew(event({ sandbox: true })),
        heldAnew(new Event(`intentic:holder`)),
    ]).toEqual([{ sandbox: false, otherAccount: true, owner: `ada@work.example` }, { sandbox: true, otherAccount: false, owner: null }, undefined, undefined]);
});
