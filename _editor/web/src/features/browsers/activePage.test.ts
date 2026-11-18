import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { activePageOf, freshestWindow, settledPick } from "./activePage";

// The rule the Browsers view's tab strip runs on: watch the agent by default, obey the user once they choose,
// and never highlight a tab that has gone away.
const page = (id: string, active = false): BrowserPage => ({ id, url: `https://example.com/${id}`, active });

test("with no pick, the strip follows the page the agent is on", () => {
    const pages = [page(`p1`), page(`p2`, true), page(`p3`)];
    expect(activePageOf(pages, undefined)?.id).toBe(`p2`);

    // The agent navigates somewhere else: the highlight moves with it, because nobody has said otherwise.
    expect(activePageOf([page(`p1`), page(`p2`), page(`p3`, true)], undefined)?.id).toBe(`p3`);
});

test("a picked tab holds, even as the agent moves on", () => {
    // p2 is where the agent is; the user is reading p1 and must not be dragged away from it.
    expect(activePageOf([page(`p1`), page(`p2`, true)], `p1`)?.id).toBe(`p1`);
});

test("a picked tab that closes falls back to the agent's, rather than highlighting nothing", () => {
    // p1 is gone from the daemon's list: the pick is stale, and the pane is already following the agent again
    // (the socket's `gone` frame drops the pin at the same moment).
    expect(activePageOf([page(`p2`, true), page(`p3`)], `p1`)?.id).toBe(`p2`);
});

test("a browser with pages but none marked active still shows one", () => {
    // The window between a page opening and the daemon's first notePage landing: the strip must not go blank.
    expect(activePageOf([page(`p1`), page(`p2`)], undefined)?.id).toBe(`p1`);
    expect(activePageOf([], undefined)).toBeUndefined();
});

test("a pick lasts until the window says that tab is in front, then the strip follows the window again", () => {
    // Picked, not yet confirmed: the pick holds.
    expect(settledPick([page(`p1`), page(`p2`, true)], `p1`, true)).toBe(`p1`);
    // Confirmed: the pick is done, so an agent switching tabs afterwards moves the strip with the picture.
    expect(settledPick([page(`p1`, true), page(`p2`)], `p1`, true)).toBeUndefined();
    // A sandbox too old to send its window's state never confirms; the pick stands as it always did.
    expect(settledPick([page(`p1`, true), page(`p2`)], `p1`, false)).toBe(`p1`);
});

const window = (seq: number | undefined, front: string, name = `browser-abc12345`): BrowserSession => {
    const copy: BrowserSession = { name, label: `x`, server: `web`, running: true, activityAt: 0, pages: [{ id: front, url: `https://example.com/`, active: true }] };
    if (seq !== undefined) {
        copy.seq = seq;
    }
    return copy;
};

test("of the list's copy and the socket's, the newer is shown", () => {
    expect(freshestWindow(window(5, `p1`), window(7, `p2`))?.pages[0]?.id).toBe(`p2`);
    // The list caught up past what the socket last sent (the socket was paused, or slower): the list's is newer.
    expect(freshestWindow(window(9, `p3`), window(7, `p2`))?.pages[0]?.id).toBe(`p3`);
});

test("the list alone says which windows exist", () => {
    expect(freshestWindow(undefined, window(7, `p2`))).toBeUndefined();
    // A socket still holding the window before a switch says nothing about the next one.
    expect(freshestWindow(window(5, `p1`, `browser-other111`), window(7, `p2`))?.name).toBe(`browser-other111`);
});

test("a sandbox too old to send state is shown from its list", () => {
    expect(freshestWindow(window(undefined, `p1`), undefined)?.pages[0]?.id).toBe(`p1`);
});
