import { type ClientDiagnostic, type ClientPage, REQUEST_ID_HEADER } from "@intentic/sandbox-contract";
import { uuid } from "../../lib/uuid";
import { sandboxAuthenticatedFetch } from "./sandboxAuthFetch";
import { currentSandboxTarget } from "./sandboxTarget";

// Carries a batch of what the browser saw (app/clientDiagnostics.ts) to the daemon's logs/client.jsonl. `keepalive` is
// load-bearing: a startup crash or a closing tab cancels an ordinary fetch with the page, but not a keepalive one;
// `sendBeacon` would survive too but can't carry the daemon's bearer header. Deliberately not through the typed daemon
// client: that wraps calls in `trackPerf`, which would make a slow report file a slow span that queues another report.
// Drops rather than retrying, and never throws back. The batch carries a request id like any daemon call, so its lines in
// client.jsonl (under `ctx`) and the daemon's own line for the POST find each other.
export const postClientDiagnostics = (events: readonly ClientDiagnostic[], page?: ClientPage): void => {
    const target = currentSandboxTarget();
    if (target === undefined) {
        // No sandbox addressed yet (the sign-in screens): nothing to report to, and nothing to keep either.
        return;
    }
    void sandboxAuthenticatedFetch(
        // allow(contract-paths): a keepalive report that must outlive the page, kept off the typed client's trackPerf span (see above)
        new Request(`${target.base}/logs/client`, {
            method: `POST`,
            headers: { "content-type": `application/json`, [REQUEST_ID_HEADER]: uuid() },
            // An absent page is left out by JSON itself.
            body: JSON.stringify({ events, page }),
            keepalive: true,
        }),
        target,
        // Never worth interrupting anyone for: a missing credential just loses the report, which beats raising a
        // sign-in gate from inside an error handler.
        { background: true },
        // allow(silent-catch): a report that cannot go is lost; reporting must never be the thing that fails
    ).catch(() => undefined);
};
