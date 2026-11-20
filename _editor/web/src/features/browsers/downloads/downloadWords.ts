import type { BrowserDownload } from "@intentic/sandbox-contract/schemas/browser-tools";
import { formatBytes, timeAgo } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// How a download reads in the list and on the toolbar: what is still arriving, how far all of it has got, and the one
// line under each name.

export const underway = (list: readonly BrowserDownload[]): BrowserDownload[] => list.filter((download) => download.state === `progress`);

// The toolbar's ring, in percent: everything arriving whose size is known, counted together. Undefined when nothing is
// arriving; 0 while only sizes nobody announced are, so the ring is drawn but says nothing it cannot know.
export const ringPercent = (list: readonly BrowserDownload[]): number | undefined => {
    const arriving = underway(list);
    if (arriving.length === 0) {
        return undefined;
    }
    const sized = arriving.filter((download) => (download.totalBytes ?? 0) > 0);
    const total = sized.reduce((sum, download) => sum + (download.totalBytes ?? 0), 0);
    const received = sized.reduce((sum, download) => sum + download.receivedBytes, 0);
    return total === 0 ? 0 : Math.min(100, Math.round((received / total) * 100));
};

// The site a download came from, for its line; nothing for a file whose source was never kept.
const sourceOf = (download: BrowserDownload): string | undefined => (URL.canParse(download.url) ? new URL(download.url).host : undefined);

/** The line under a download's name: how far it has got, or how it ended and when. */
export const downloadLine = (download: BrowserDownload, now = Date.now()): string => {
    const source = sourceOf(download);
    const tail = source === undefined ? `` : ` · ${source}`;
    switch (download.state) {
        case `progress`:
            return (download.totalBytes === undefined
                ? t(`browsers.tools.receivedSoFar`, { received: formatBytes(download.receivedBytes) })
                : t(`browsers.tools.receivedOf`, { received: formatBytes(download.receivedBytes), total: formatBytes(download.totalBytes) })) + tail;
        case `done`:
            return `${formatBytes(download.receivedBytes)} · ${timeAgo(download.finishedAt ?? download.startedAt, { now })}${tail}`;
        case `canceled`:
            return t(`browsers.tools.stopped`) + tail;
        case `failed`:
            return t(`browsers.tools.failed`) + tail;
    }
};
