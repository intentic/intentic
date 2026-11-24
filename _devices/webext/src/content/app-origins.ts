// The pages a pairing may be offered from: the hosted editor's own origin, and nothing else on intentic.dev. Until
// 2026-11-24 the bridge ran on every `*.intentic.dev` page, and sandboxes publish pages on `*.sbx.intentic.dev`, so
// anyone's published page could offer this browser to their own sandbox behind a name it chose. The manifest's
// content script matches these exactly (pair-bridge.test.ts holds the two together). A self-hosted platform's editor is
// on its operator's own domain, which no build of this extension can list; there the person pastes the code its
// Connect dialog shows into the popup, as they did before.
export const APP_ORIGINS: readonly string[] = ["https://app.intentic.dev"];

export const isAppOrigin = (origin: string | undefined): origin is string => origin !== undefined && APP_ORIGINS.includes(origin);

// Whether the bridge may relay a message a page posted: from this window itself (not an iframe or an opener it embeds),
// at its own origin, on an app origin.
export const fromAppWindow = (
    event: { readonly source: unknown; readonly origin: string },
    here: { readonly window: unknown; readonly origin: string },
): boolean => event.source === here.window && event.origin === here.origin && isAppOrigin(here.origin);

// Where a message from a tab came from, as Chrome says it: `origin` (Chrome 80), else the sender's URL. Only the browser
// fills these in, so a page cannot claim another origin.
export const senderOrigin = (sender: { readonly origin?: string; readonly url?: string }): string | undefined => {
    if (sender.origin !== undefined) {
        return sender.origin;
    }
    try {
        return sender.url === undefined ? undefined : new URL(sender.url).origin;
    } catch {
        // allow(silent-catch): a sender address that does not parse names no origin, and is refused as none
        return undefined;
    }
};
