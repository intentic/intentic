import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// WHAT A PROVIDER'S OWN PAGES WILL SAY that Intentic's words don't prepare for, said before the reader leaves for them.
// Some sign-ins run through another product's door: Google's through Google Antigravity, Devin's through Windsurf. A
// reader who pressed "Connect Google" and met a page naming a different app, then a warning to sign in only if they got
// that app from Google Play, had every reason to stop (UX review 2026-10-18, F03, F09). Keyed by provider id and kept
// editor-side: the copy is the reader's language, and the contract carries no per-provider prose to reuse.
//
// Said as signs, not a paragraph: each is the words the page shows, to be recognised there at a glance, and a few
// words on what they mean. Nobody reads a paragraph on the way to a sign-in; they match what's on screen.

export interface ConnectTripSign {
    readonly icon: IconName;
    // The words as the provider's page shows them.
    readonly shows: string;
    // What they mean here, in a few words.
    readonly means: string;
    // A warning the provider puts up: drawn in the warning tone so the reader knows it's the one they'll meet.
    readonly warning?: boolean;
}

export interface ConnectTripNote {
    readonly signs: readonly ConnectTripSign[];
    // The note is about a warning the reader may reasonably heed, so it offers a way to another provider beside it.
    readonly offerElsewhere: boolean;
}

export const connectTripNote = (provider: AgentProvider, flow: { readonly redirect: boolean }): ConnectTripNote | undefined => {
    if (provider === `gemini`) {
        return {
            signs: [
                { icon: `google`, shows: `Google Antigravity`, means: t(`sandbox.connectFlow.tripGoogleAppMeans`) },
                { icon: `exclamation-triangle`, shows: t(`sandbox.connectFlow.tripGooglePlay`), means: t(`sandbox.connectFlow.tripGooglePlayMeans`), warning: true },
            ],
            offerElsewhere: true,
        };
    }
    if (provider === `devin`) {
        const windsurf: ConnectTripSign = { icon: `globe`, shows: `Windsurf`, means: t(`sandbox.connectFlow.tripWindsurfMeans`) };
        // Only the paste-back flow ends on Devin's token page; a caught landing ends on an address like any other.
        const token: ConnectTripSign = { icon: `key`, shows: t(`sandbox.connectFlow.tripDevinToken`), means: t(`sandbox.connectFlow.tripDevinTokenMeans`) };
        return { signs: flow.redirect ? [windsurf] : [windsurf, token], offerElsewhere: false };
    }
    return undefined;
};
