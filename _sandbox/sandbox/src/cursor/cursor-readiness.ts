import type { AgentEvent } from "@intentic/sandbox-contract";
import type { CursorStore } from "./cursor-credentials.js";
import { CURSOR_SDK_MISSING, cursorSdk } from "./cursor-sdk.js";

/* CAN CURSOR SERVE A TURN HERE, and if not, which of the reasons is it, asked in ONE place because two callers
 * need the same answer at different moments: planCursorTurn as the turn's refusal, and the adapter's health
 * probe as the picker's greyed-out tooltip. The codex-readiness.ts precedent, and it exists for the same
 * reason: two separately-written copies of the same condition drift, and the user meets whichever one happens
 * to be wrong.
 *
 * THREE REASONS, AND THEY LOOK ALIKE FROM THE OUTSIDE. "Cursor doesn't work here" can mean the image carries no
 * Cursor runtime (a rebuild fixes it), no account is connected (a sign-in fixes it), or every connected
 * account's key has expired (a sign-in again fixes it, on a row that already exists). Sending someone to
 * connect an account they already connected is the failure this ordering is written to avoid. */

export type CursorReadiness =
    | { readonly ok: true }
    | {
          readonly ok: false;
          readonly detail: string;
          // Set only where connecting an account is what fixes it: this is what puts the connect gate in front
          // of the user. A missing runtime is not that, and offering a sign-in for it would be a dead end.
          readonly code?: Extract<AgentEvent, { kind: "error" }>["code"];
      };

export const cursorReadiness = async (store: CursorStore): Promise<CursorReadiness> => {
    // First, because it is true whatever the credential says: the runtime is a pack, and a published image
    // does not carry it (see cursor-sdk.ts for why it cannot).
    if ((await cursorSdk()) === undefined) {
        return { ok: false, detail: CURSOR_SDK_MISSING };
    }
    const accounts = await store.credentials();
    if (accounts.length === 0) {
        return { ok: false, code: "subscription-required", detail: "Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor." };
    }
    if (!accounts.some((account) => account.apiKeyExpiresAtMs === undefined || account.apiKeyExpiresAtMs > Date.now())) {
        // An account IS connected, so this is deliberately NOT `subscription-required`: the fix is a fresh
        // sign-in on a row the user can already see, and a connect gate offering to add a first account would
        // send them looking for something that is not the problem.
        return { ok: false, detail: "Your Cursor sign-in has expired. Connect it again in Sandbox ▸ Agent to keep running turns." };
    }
    return { ok: true };
};
