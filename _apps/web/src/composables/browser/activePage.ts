import type { BrowserPage } from "@intentic/sandbox-contract";

/* WHICH TAB READS AS SELECTED — the rule the Browsers view's strip and its address line both follow.
 *
 * Until the user picks one this FOLLOWS THE AGENT: the daemon's `active` page is the one it most recently
 * opened or navigated, so the strip highlights whatever the picture is already showing. After a pick it is the
 * pick, and it stays there as the agent moves on — matching the pin the daemon put on the stream, and the whole
 * reason a tab strip is worth having.
 *
 * A picked tab that CLOSES falls back to the agent's, because the alternative is a strip highlighting nothing
 * while the pane shows something. The daemon drops the pin on the same event (the socket's `gone` frame), so
 * both ends land back on following without either having to tell the other. */
export const activePageOf = (pages: readonly BrowserPage[], picked: string | undefined): BrowserPage | undefined =>
    pages.find((page) => page.id === picked) ?? pages.find((page) => page.active) ?? pages[0];
