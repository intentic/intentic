import type { CDPSession } from "playwright";
import type { PageHistory } from "./window-record.js";

// Whether a tab can go back or forward, which a browser's own buttons show by greying out and the picture crops away.
// Read off Chromium's own history list after each arrival, a same-document one (pushState) included, since that list
// is the one Back walks. Undefined when the page closed or navigated away mid-read; the next arrival reads it again.
export const historyOf = async (session: CDPSession): Promise<PageHistory | undefined> => {
    try {
        const { currentIndex, entries } = await session.send("Page.getNavigationHistory");
        return { back: currentIndex > 0, forward: currentIndex < entries.length - 1 };
    } catch {
        // allow(silent-catch): a page gone mid-read has no history left to show; its tab leaves the strip anyway.
        return undefined;
    }
};
