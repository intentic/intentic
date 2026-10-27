import { parkHandoff, redeemHandoff } from "../world/handoffs";
import { demoIdToken } from "../world/identity";
import { type PlatformRouter, refusePlatform } from "./serve";

// THE DESKTOP APP'S DOORS on the platform: the hand-off of a browser's sign-in to the app (world/handoffs.ts), its
// redemption, and the Google ID token the platform already holds for the account. A browser tab sends the first and the
// last from /desktop-auth, the page the app opens in the reader's browser; the redeem comes from the app's webview, and
// from /desktop-auth/complete where a hand-off lands in a window.
export const desktopAnswers = {
    handoff: ({ idToken, challenge }) => ({ handoff: parkHandoff(challenge, idToken) }),
    redeem: async ({ handoff, verifier }) => (await redeemHandoff(handoff, verifier)) ?? refusePlatform(`This sign-in link has already been used or expired.`, 404),
    // The demo account signed in with Google (world/identity.ts), so the platform holds a fresh token for it.
    googleIdToken: () => ({ idToken: demoIdToken(``) }),
} satisfies NonNullable<PlatformRouter[`desktop`]>;
