import type { NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import type { LocationQuery } from "vue-router";
import { z } from "zod";
import { environment } from "../../app/environments/environment";
import { useAuth } from "../../client/auth/useAuth";
import { useGoogleIdentity } from "../../client/auth/useGoogleIdentity";
import { apiClient } from "../../lib/useApi";

// THE BROWSER'S SIGN-IN, TAKEN BY THIS WEBVIEW (the desktop app's auth.rs `complete`, which hands over `handoff` and
// `verifier`). Redeem the browser's single-use row, verify the Better Auth token for a Set-Cookie session, then adopt the
// Google ID token beside it when there is one; an account without Google gets its sandbox sessions from platform identity
// assertions instead. A link spent or refused cannot be tried again: the way on is a fresh sign-in.
//
// Shared by the screen the hand-off lands on in a window with nothing on it yet (DesktopAuthComplete.vue) and by the
// dialog that takes it in place over the view the reader is on (signInDialog.ts `arriveInPlace`).

/** The completion's address as the app writes it (auth.rs `complete_path`). */
export interface DesktopHandoff {
    readonly handoff: string;
    readonly verifier: string;
    /** `back=agent`: the sign-in began on a folder of this computer, which gets the reader back once it is done. */
    readonly backToFolder: boolean;
}

const HandoffQuerySchema = z.object({ handoff: z.string().min(1), verifier: z.string().min(1), back: z.string().optional() });

/** The hand-off a completion's query carries; undefined for one missing either half, which no redemption can take. */
export const readDesktopHandoff = (query: LocationQuery): DesktopHandoff | undefined => {
    const parsed = HandoffQuerySchema.safeParse(query);
    return parsed.success ? { handoff: parsed.data.handoff, verifier: parsed.data.verifier, backToFolder: parsed.data.back === `agent` } : undefined;
};

/** Undefined once this webview is signed in; otherwise why not, in the reader's words. */
export const redeemDesktopHandoff = async (taken: DesktopHandoff | undefined): Promise<NoticeModel | undefined> => {
    if (taken === undefined) {
        return noticeOf(t(`auth.desktopAuthComplete.linkIncomplete`));
    }
    try {
        const { ott, idToken } = await apiClient.desktop.redeem({ handoff: taken.handoff, verifier: taken.verifier });
        // Called directly, not through oRPC: this lives under /api/auth. Only its Set-Cookie matters, not the body.
        const verified = await globalThis.fetch(`${environment.api.url}/api/auth/one-time-token/verify`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            credentials: `include`,
            body: JSON.stringify({ token: ott }),
        });
        if (!verified.ok) {
            return noticeOf(t(`auth.desktopAuthComplete.expired`));
        }
        if (idToken !== undefined && !useGoogleIdentity().adoptIdToken(idToken)) {
            return noticeOf(t(`auth.desktopAuthComplete.expired`));
        }
        await useAuth().refresh();
        return undefined;
    } catch (error) {
        return noticeFrom(error, t(`auth.desktopAuthComplete.couldntFinish`));
    }
};
