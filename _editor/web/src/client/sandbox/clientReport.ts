import type { ClientDiagnostic } from "@intentic/sandbox-contract";
import { sandboxAuthenticatedFetch } from "./sandboxAuthFetch";
import { currentSandboxTarget } from "./sandboxTarget";

// Carries a batch of what the browser saw (app/clientDiagnostics.ts) to the daemon's logs/client.jsonl. `keepalive` is
// load-bearing: a startup crash or a closing tab cancels an ordinary fetch with the page, but not a keepalive one;
// `sendBeacon` would survive too but can't carry the daemon's bearer header. Deliberately not through the typed daemon
// client: that wraps calls in `trackPerf`, which would make a slow report file a slow span that queues another report.
// Drops rather than retrying, and never throws back.
export const postClientDiagnostics = (events: readonly ClientDiagnostic[]): void => {
    const target = currentSandboxTarget();
    if (target === undefined) {
        // No sandbox addressed yet (the sign-in screens): nothing to report to, and nothing to keep either.
        return;
    }
    void sandboxAuthenticatedFetch(
        // allow(contract-paths): a keepalive report that must outlive the page, kept off the typed client's trackPerf span (see above)
        new Request(`${target.base}/logs/client`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ events }),
            keepalive: true,
        }),
        target,
        // Never worth interrupting anyone for: a missing credential just loses the report, which beats raising a
        // sign-in gate from inside an error handler.
        { background: true },
        // allow(silent-catch): a report that cannot go is lost; reporting must never be the thing that fails
    ).catch(() => undefined);
};
