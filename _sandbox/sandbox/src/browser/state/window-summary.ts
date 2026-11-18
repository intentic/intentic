import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { navigationFields } from "../navigation/page-navigation.js";
import { opt } from "../../opt.js";
import type { BrowserSessionRecord, PageRecord } from "./window-record.js";

// A browser window as the contract lists it (BrowserSessionSchema): the browsers list's entry, and the `state` its view
// sockets send, one shape for both so a viewer can hold either copy.

// An address that does not parse (a page mid-navigation can hold one) has no host to name.
const hostOf = (url: string | undefined): string | undefined =>
    url === undefined || url === "" || url === "about:blank" || !URL.canParse(url) ? undefined : new URL(url).host;

// Live sessions list only open tabs; finished ones list every tab they ever had, since a closed browser only answers
// where it went, and nothing of a closed one is still loading.
// title is omitted rather than set to undefined, per exactOptionalPropertyTypes.
const summarizePage = (entry: PageRecord, activeId: string | undefined, running: boolean): BrowserPage => {
    const page: BrowserPage = running
        ? {
              id: entry.id,
              ...navigationFields(entry.navigation, entry.url),
              active: entry.id === activeId,
              ...opt("canGoBack", entry.history?.back),
              ...opt("canGoForward", entry.history?.forward),
          }
        : { id: entry.id, url: entry.url, active: entry.id === activeId };
    return entry.title === undefined ? page : { ...page, title: entry.title };
};

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
        label: labelOf(record, active?.title ?? hostOf(active?.url)),
        server: record.server,
        running,
        activityAt: record.activityAt,
        pages: [...record.pages.values()].filter((entry) => !running || !entry.closed).map((entry) => summarizePage(entry, activeId, running)),
        ...opt("help", record.help),
        ...opt("dialog", running ? openDialog(record) : undefined),
        ...opt("finishedAt", record.finishedAt),
        ...opt("own", record.own ? true : undefined),
        ...opt("owner", record.owner),
    };
};
