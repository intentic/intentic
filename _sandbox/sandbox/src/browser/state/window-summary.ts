import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { navigationFields } from "../navigation/page-navigation.js";
import { opt } from "../../opt.js";
import { listClosed } from "./closed-tabs.js";
import { shownFavicon, shownTitle, shownUrl } from "./deferred-tabs.js";
import type { BrowserSessionRecord, PageRecord } from "./window-record.js";
import type { TabSound } from "../tabs/tab-helper.js";
import { profileDownloads } from "../downloads/browser-downloads.js";
import { windowRecording } from "../media/recordings.js";
import { permissionAskOf } from "../permissions/window-permissions.js";
import { fileChooserOf } from "../uploads/file-chooser.js";

// A browser window as the contract lists it (BrowserSessionSchema): the browsers list's entry, and the `state` its view
// sockets send, one shape for both so a viewer can hold either copy.

// An address that does not parse (a page mid-navigation can hold one) has no host to name.
const hostOf = (url: string | undefined): string | undefined =>
    url === undefined || url === "" || url === "about:blank" || !URL.canParse(url) ? undefined : new URL(url).host;

// Live sessions list only open tabs; finished ones list every tab they ever had, since a closed browser only answers
// where it went, and nothing of a closed one is still loading. A tab a restore has not loaded yet is listed as where it
// will go (deferred-tabs.ts), with nothing in flight.
// title is omitted rather than set to undefined, per exactOptionalPropertyTypes.
const summarizePage = (entry: PageRecord, activeId: string | undefined, running: boolean, sound: TabSound | undefined): BrowserPage => {
    const url = shownUrl(entry);
    const live = running && entry.deferred === undefined;
    const page: BrowserPage = live
        ? {
              id: entry.id,
              ...navigationFields(entry.navigation, entry.url),
              active: entry.id === activeId,
              ...opt("canGoBack", entry.history?.back),
              ...opt("canGoForward", entry.history?.forward),
          }
        : { id: entry.id, url, active: entry.id === activeId };
    return {
        ...page,
        ...opt("title", shownTitle(entry)),
        ...opt("favicon", shownFavicon(entry)),
        ...opt("audible", running ? sound?.audible : undefined),
        ...opt("muted", running ? sound?.muted : undefined),
    };
};

// A tab's sound as the window's tab helper last reported it, once the tab's target id is known; undefined where the
// window has no helper.
const soundOf = (record: BrowserSessionRecord, entry: PageRecord): TabSound | undefined =>
    entry.targetId === undefined ? undefined : record.sound?.get(entry.targetId);

// The kinds of JavaScript dialog Chromium opens; Playwright names them in a plain string.
const DIALOG_KINDS = ["alert", "confirm", "prompt", "beforeunload"] as const;

// The one open dialog a running session has, if any; a page holds at most one, and Chromium queues the rest behind it.
const openDialog = (record: BrowserSessionRecord): BrowserSession["dialog"] => {
    for (const entry of record.pages.values()) {
        const dialog = entry.dialog;
        const kind = DIALOG_KINDS.find((known) => known === dialog?.type());
        if (dialog !== undefined && kind !== undefined && !entry.closed) {
            const defaultValue = dialog.defaultValue();
            return { pageId: entry.id, kind, message: dialog.message(), ...opt("defaultValue", defaultValue === "" ? undefined : defaultValue) };
        }
    }
    return undefined;
};

// The file chooser a running session's page is waiting on, if any; like a dialog, one at a time is what is shown.
const openFileChooser = (record: BrowserSessionRecord): BrowserSession["fileChooser"] => {
    for (const entry of record.pages.values()) {
        const chooser = entry.closed ? undefined : fileChooserOf(entry.page, entry.id);
        if (chooser !== undefined) {
            return chooser;
        }
    }
    return undefined;
};

// Logged-in label leads with owner so same-site identities stay distinct; web has none, so it's page-first, and so is
// the person's own window, which is nobody's account but theirs.
const labelOf = (record: BrowserSessionRecord, page: string | undefined): string =>
    record.own
        ? (page ?? "Your browser")
        : record.server === "web"
          ? (page ?? record.server)
          : page === undefined
            ? record.server
            : `${record.server} · ${page}`;

export const summarizeWindow = (record: BrowserSessionRecord): BrowserSession => {
    const running = record.finishedAt === undefined;
    // Running session's active tab is the one in front; finished one's is the one it ended on.
    const activeId = running ? record.activePageId : record.lastPageId;
    const active = activeId === undefined ? undefined : record.pages.get(activeId);
    return {
        name: record.name,
        seq: record.seq,
        label: labelOf(record, active === undefined ? undefined : (shownTitle(active) ?? hostOf(shownUrl(active)))),
        server: record.server,
        running,
        activityAt: record.activityAt,
        pages: [...record.pages.values()]
            .filter((entry) => !running || !entry.closed)
            .map((entry) => summarizePage(entry, activeId, running, soundOf(record, entry))),
        ...opt("closed", running ? listClosed(record.closed) : undefined),
        ...opt("help", record.help),
        ...opt("dialog", running ? openDialog(record) : undefined),
        ...opt("downloads", profileDownloads(record.server)),
        ...opt("fileChooser", running ? openFileChooser(record) : undefined),
        ...opt("permissionAsk", running ? permissionAskOf(record) : undefined),
        ...opt("recording", running ? windowRecording(record.name) : undefined),
        ...opt("finishedAt", record.finishedAt),
        ...opt("own", record.own ? true : undefined),
        ...opt("owner", record.owner),
    };
};
