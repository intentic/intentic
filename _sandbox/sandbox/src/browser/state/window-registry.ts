import type { BrowserSessionRecord } from "./window-record.js";

// Every browser window the daemon knows of, by session name, open or recently finished. browser-sessions.ts adds and
// retires them; the modules that act on a window's tabs or its help request (browser-tabs.ts, browser-help.ts) find
// them here rather than through that module, which would otherwise hold every verb on a window in one file.
export const browserWindows = new Map<string, BrowserSessionRecord>();

// A window open now and attached, by name; undefined once it has finished, or before its attach lands.
export const openWindow = (name: string): BrowserSessionRecord | undefined => {
    const record = browserWindows.get(name);
    return record?.finishedAt === undefined && record?.context !== undefined ? record : undefined;
};
