import type { GroupSamples } from "./context.ts";

// The visitor's own window and its tab, as the demo's browser seeds them (src/browser.ts), with the downloads, asks and
// sites its browser tools hand back (src/daemon/machine/browserTools.ts). A finished download is saved and then removed,
// so the run leaves the list as it found it apart from that one.
const WINDOW = `browser-own`;
const PAGE = `page_signup`;
const SITE = `https://acme-shop.test`;

export const browserSamples: GroupSamples<`browser`> = () => ({
    downloads: undefined,
    downloadTicket: { id: `dl-invoice` },
    saveDownload: { id: `dl-invoice` },
    cancelDownload: { id: `dl-dataset` },
    removeDownload: { id: `dl-logo` },
    answerFileChooser: { name: WINDOW, chooser: `chooser:${PAGE}` },
    dropFiles: { name: WINDOW, pageId: PAGE, x: 120, y: 80, uploads: [`upload-demo`] },
    answerPermission: { name: WINDOW, ask: `ask:${PAGE}`, setting: `block` },
    site: { name: WINDOW, origin: SITE },
    setSitePermission: { name: WINDOW, origin: SITE, permission: `notifications`, setting: `block` },
    clearSiteData: { name: WINDOW, origin: SITE },
    printPage: { name: WINDOW, pageId: PAGE },
    viewSource: { name: WINDOW, pageId: PAGE },
    devtools: { name: WINDOW, pageId: PAGE },
});
