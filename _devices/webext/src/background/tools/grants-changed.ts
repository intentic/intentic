import { webextGrantsChangedUrl } from "@intentic/sandbox-contract/webext";
import { store } from "../store.js";

// How long the tell may take: the sandbox's fallback check reads this browser's sites anyway, so a slow one is dropped.
const TELL_TIMEOUT_MS = 5_000;

// Tells every paired sandbox that this browser's allowed sites changed (2026-10-20), so each reads them at once and an
// agent waiting on `ask_access` goes on now rather than on its sandbox's fallback check. The sites are the same for
// every sandbox (tab-access.ts currentGrants), so all of them are told. Authenticated as this browser's other calls to
// a sandbox are (lend.ts, ticket.ts): that sandbox's own enrollment token, as a bearer.
export const notifySandboxGrantsChanged = async (): Promise<void> => {
    const sandboxes = await store.sandboxes();
    await Promise.all(
        sandboxes.map(
            async (sandbox) =>
                await fetch(webextGrantsChangedUrl(sandbox.url), {
                    method: "POST",
                    headers: { authorization: `Bearer ${sandbox.token}` },
                    signal: AbortSignal.timeout(TELL_TIMEOUT_MS),
                    // allow(silent-catch): best-effort; the sandbox's fallback check reads this browser's sites anyway.
                }).catch(() => undefined),
        ),
    );
};
