import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { t } from "@intentic/ui/i18n";

// WHAT A PROVIDER'S OWN PAGES WILL SAY that Intentic's words don't prepare for, said before the reader leaves for them.
// Some sign-ins run through another product's door: Google's through Google Antigravity, Devin's through Windsurf. A
// reader who pressed "Connect Google" and met a page naming a different app, then a warning to sign in only if they got
// that app from Google Play, had every reason to stop (UX review 2026-10-18, F03, F09). Keyed by provider id and kept
// editor-side: the copy is the reader's language, and the contract carries no per-provider prose to reuse.

export interface ConnectTripNote {
    readonly text: string;
    // The note is about a warning the reader may reasonably heed, so it offers a way to another provider beside it.
    readonly offerElsewhere: boolean;
}

export const connectTripNote = (provider: AgentProvider, flow: { readonly redirect: boolean }): ConnectTripNote | undefined => {
    if (provider === `gemini`) {
        return { text: t(`sandbox.connectFlow.tripGoogle`), offerElsewhere: true };
    }
    if (provider === `devin`) {
        // Only the paste-back flow ends on Devin's token page; a caught landing ends on an address like any other.
        return { text: flow.redirect ? t(`sandbox.connectFlow.tripDevin`) : t(`sandbox.connectFlow.tripDevinToken`), offerElsewhere: false };
    }
    return undefined;
};
