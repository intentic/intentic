import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";

// Follows the daemon's `active` page, the tab the window has in front, until picked, then stays on the pick. If the
// picked tab closes, falls back to `active` again, matching the daemon's own pin drop on that event.
export const activePageOf = (pages: readonly BrowserPage[], picked: string | undefined): BrowserPage | undefined =>
    pages.find((page) => page.id === picked) ?? pages.find((page) => page.active) ?? pages[0];

// What is left of a pick once the window has spoken. A window that sends its own state brings the picked tab in front
// for everyone, so once it says that tab is in front the pick has done its work, and the strip follows the window again
// (an agent switching tabs later moves it, as it moves the picture). A sandbox too old to send state never says, and
// its pick stands, as it always did.
export const settledPick = (pages: readonly BrowserPage[], picked: string | undefined, windowSpeaks: boolean): string | undefined =>
    windowSpeaks && pages.some((page) => page.id === picked && page.active) ? undefined : picked;

// A browser window reaches the editor two ways: in the browsers list, refetched on the runtime feed's beat, and on its
// own view socket, sent whole on every change (`state`). Both carry the window's `seq`; the higher is the newer, and
// that is the one shown. The list alone decides which windows exist: a window it no longer lists is not shown from a
// socket's last word.
export const freshestWindow = (listed: BrowserSession | undefined, streamed: BrowserSession | undefined): BrowserSession | undefined => {
    if (listed === undefined || streamed === undefined || streamed.name !== listed.name) {
        return listed;
    }
    return (streamed.seq ?? 0) >= (listed.seq ?? 0) ? streamed : listed;
};
