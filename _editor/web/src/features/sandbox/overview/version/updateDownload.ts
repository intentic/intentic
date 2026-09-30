import type { PreparingUpdate } from "@intentic/sandbox-contract";

// THE NEXT UPDATE'S DOWNLOAD, AS THE UPDATE CARD FOLLOWS IT. The machine that runs a sandbox downloads its next update
// by itself (the machine agent's timer, `ic sandbox prepare --auto`), and the card starts that same download when it
// opens (useBackgroundDownload). While one runs, `ic` keeps a marker on /history with its step and how far the pull has
// got (`info.preparing`), and the card draws that in place of its buttons. Pure, so each rule is checked without a card.

/** How often the card re-reads `system.info` while a download is running: often enough that the bar moves. */
export const DOWNLOAD_POLL_MS = 3_000;
/** How often while an update is on offer but not downloaded: enough to notice the machine's own timer start one. */
export const OFFER_POLL_MS = 30_000;
/** The card asks for the same release's download at most once in this long, per sandbox and per tab. */
export const START_AGAIN_MS = 30 * 60_000;

export interface DownloadState {
    /** An update is on offer from this card, to a sandbox whose own machine downloads it (not hosted, not deployed). */
    readonly offered: boolean;
    /** It is already downloaded, so what is left is the restart. */
    readonly staged: boolean;
    /** The machine's word on a download running now; absent when none is, or it stopped saying so. */
    readonly preparing: PreparingUpdate | undefined;
    /** The card's own request for the download is still out, and the machine has not started saying how far it got. */
    readonly starting: boolean;
}

/** Whether a download is running, as far as this card can tell: said by the machine, or just asked for by the card. */
export const downloading = ({ offered, staged, preparing, starting }: DownloadState): boolean => offered && !staged && (preparing !== undefined || starting);

/** How often the card re-reads, or false when nothing on it can change by itself. */
export const downloadPollMs = (state: DownloadState): number | false => {
    if (!state.offered || state.staged) {
        return false;
    }
    return downloading(state) ? DOWNLOAD_POLL_MS : OFFER_POLL_MS;
};

/** Whether the card may ask for this release's download again, given when it last did (in this tab). */
export const mayStart = (lastAsked: number | undefined, now: number): boolean => lastAsked === undefined || now - lastAsked >= START_AGAIN_MS;

/** The step a download is on, in the card's words; a step a newer `ic` names reads as the download itself. */
export type DownloadStep = `starting` | `download` | `build` | `check`;
export const downloadStep = (preparing: PreparingUpdate | undefined): DownloadStep => {
    if (preparing === undefined) {
        return `starting`;
    }
    return preparing.phase === `build` || preparing.phase === `check` ? preparing.phase : `download`;
};

/** A percent only while pulling and only when the machine measured one: every other step is a bar without an end. */
export const downloadPercent = (preparing: PreparingUpdate | undefined): number | undefined =>
    preparing !== undefined && downloadStep(preparing) === `download` && preparing.percent !== undefined ? Math.round(preparing.percent) : undefined;
