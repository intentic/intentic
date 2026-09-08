import type { BrowserPage } from "@intentic/sandbox-contract";

// Follows the daemon's `active` page until picked, then stays on the pick. If the picked tab closes, falls back to
// `active` again, matching the daemon's own pin drop on that event.
export const activePageOf = (pages: readonly BrowserPage[], picked: string | undefined): BrowserPage | undefined =>
    pages.find((page) => page.id === picked) ?? pages.find((page) => page.active) ?? pages[0];
