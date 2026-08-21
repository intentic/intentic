import type { BrowserPage } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { activePageOf } from "./activePage";

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
