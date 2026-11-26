import { json } from "../../transport";

// The issues extension's backend namespace (its src/server/routes.ts), which its views read through `api.backend` since
// the bug intake and its inbox left the daemon (2026-11-26): the inbox, which the demo's sandbox has been sent nothing
// for yet, so it is there and empty, as a new one is. The vendored issues extension (vendor/extensions.json) reads it
// once its pin reaches a commit with that backend; one pinned before it still asks the daemon's GET /issues, which no
// daemon of this build serves.
const ISSUES = `/x/intentic.issues`;

export const issuesBackend = {
    [`GET ${ISSUES}/issues`]: (): Response => json({ issues: [], invalid: [] }),
} satisfies Readonly<Record<string, () => Response>>;
