import type { Page } from "@intentic/sandbox-contract/events/requests";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { AgentTranscript } from "../../../../models/conversations/transcript/agentTranscript";

// ONE PAGE AN AGENT SHOWED, FOUND BY ITS ID IN ITS CONVERSATION'S RECORD, for the screen that shows it whole
// (ChatPageScreen). A page's id is the daemon's (ten hex characters, minted per page in the conversation, page-store.ts)
// and a redraw (`show_page` with `replaces`) keeps it, drawing again further down at a new path and a higher revision:
// so an id names one page and every drawing of it, and the one that stands is the last. An asked page (`ask_page`) is
// never redrawn, so its id names exactly one card.

/** The page a row draws, shown or asked on. */
const pageOfRow = (row: Pick<TranscriptRow, `page` | `pageAsk`>): Page | undefined => row.page ?? row.pageAsk?.page;

/** The row holding the drawing of `pageId` that stands: the last one, since a redraw comes after what it replaced. */
export const standingDrawing = <Row extends Pick<TranscriptRow, `page` | `pageAsk`>>(rows: readonly Row[], pageId: string): Row | undefined =>
    rows.findLast((row) => pageOfRow(row)?.id === pageId);

/** What a search of the record found: the rows of the record's page that holds it, or why there is nothing to draw. */
export type PageFound = { readonly kind: `found`; readonly rows: readonly TranscriptRow[] } | { readonly kind: `missing` | `gone` };

// How many of the record's pages a search reads before it stops: the daemon's page is the last 20 turns, so this is a
// conversation a few hundred turns long, past which a page is too old to be what anyone opened from a notification.
export const PAGES_SEARCHED = 25;

/**
 * Reads the record newest first, starting from `opening` (the page the chat already holds), and hands back the first
 * page of it that holds `pageId`: the newest, so the drawing in it that stands is the last of all. `older` reads the
 * page above a cursor. `missing` once the record runs out (or the search does) without it, `gone` for a conversation the
 * daemon does not have.
 */
export const findPage = async (pageId: string, opening: AgentTranscript, older: (before: number) => Promise<AgentTranscript>): Promise<PageFound> => {
    let page = opening;
    for (let read = 1; ; read += 1) {
        if (page === `gone`) {
            return { kind: `gone` };
        }
        if (standingDrawing(page.messages, pageId) !== undefined) {
            return { kind: `found`, rows: page.messages };
        }
        if (!page.more || page.from <= 0 || read >= PAGES_SEARCHED) {
            return { kind: `missing` };
        }
        page = await older(page.from);
    }
};
