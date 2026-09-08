import type { AgentEvent } from "@intentic/sandbox-contract";
import type { CursorStore } from "./cursor-credentials.js";
import { CURSOR_SDK_MISSING, cursorSdk } from "./cursor-sdk.js";

// Single answer to whether Cursor can serve a turn, read by both planCursorTurn's refusal and the health probe's
// tooltip. Three reasons look alike from outside: no runtime (rebuild), no account (sign-in), or every key expired
// (sign-in again). Credential checks come first, since a sign-in can bootstrap the runtime.

export type CursorReadiness =
    | { readonly ok: true }
    | {
          readonly ok: false;
          readonly detail: string;
          // Set only where connecting an account fixes it; a missing runtime beside a usable credential is not that.
          readonly code?: Extract<AgentEvent, { kind: "error" }>["code"];
      };

export const cursorReadiness = async (store: CursorStore): Promise<CursorReadiness> => {
    const accounts = await store.credentials();
    if (accounts.length === 0) {
        return { ok: false, code: "subscription-required", detail: "Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor." };
    }
    if (!accounts.some((account) => account.apiKeyExpiresAtMs === undefined || account.apiKeyExpiresAtMs > Date.now())) {
        // Not subscription-required: the account is connected, the fix is a fresh sign-in on an existing row.
        return { ok: false, detail: "Your Cursor sign-in has expired. Connect it again in Sandbox ▸ Agent to keep running turns." };
    }
    // Pack absence checked last: connect installs a temp copy, so this means the credential outlived the image.
    if ((await cursorSdk()) === undefined) {
        return { ok: false, detail: CURSOR_SDK_MISSING };
    }
    return { ok: true };
};
