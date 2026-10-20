import { webextGrantsChangedUrl } from "@intentic/sandbox-contract/webext";
import { store } from "../store.js";

// How long the tell may take: the sandbox's fallback check reads this browser's sites anyway, so a slow one is dropped.
const TELL_TIMEOUT_MS = 5_000;

// Tells the paired sandbox that this browser's allowed sites changed (2026-10-20), so it reads them at once and the
// agent waiting on `ask_access` goes on now rather than on the sandbox's fallback check. Authenticated as this
// browser's other calls to its sandbox are (lend.ts, ticket.ts): its enrollment token, as a bearer.
export const notifySandboxGrantsChanged = async (): Promise<void> => {
    const sandbox = await store.sandbox();
    if (sandbox === undefined) {
        return;
    }
    await fetch(webextGrantsChangedUrl(sandbox.url), {
        method: "POST",
        headers: { authorization: `Bearer ${sandbox.token}` },
        signal: AbortSignal.timeout(TELL_TIMEOUT_MS),
        // allow(silent-catch): best-effort; the sandbox's fallback check reads this browser's sites anyway.
    }).catch(() => undefined);
};
