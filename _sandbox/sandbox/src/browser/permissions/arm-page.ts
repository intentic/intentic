import type { CDPSession, Page } from "playwright";
import { watchFileChooser } from "../uploads/file-chooser.js";
import { armPageAsks, armWindowPermissions, type PermissionWindow } from "./window-permissions.js";

/**
 * What one page of a window answers through the person rather than Chromium's own chrome, which the picture never shows:
 * its file chooser (uploads/file-chooser.ts) and its permission asks (window-permissions.ts). Called once the page's
 * own DevTools session is open; the window is armed with its first page. `changed` hears either kind of ask come or go.
 */
export const armPageTools = async (window: PermissionWindow, page: Page, pageId: string, session: CDPSession, changed: () => void): Promise<void> => {
    armWindowPermissions(window, changed);
    watchFileChooser(page, changed);
    await armPageAsks(window, page, pageId, session);
};
