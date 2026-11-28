import type { S2sContact, S2sContactScope, S2sGrants, S2sGrantsUpdate } from "@intentic/sandbox-contract/schemas/s2s";
import { canonicalJson } from "@intentic/sandbox-contract/s2s";
import { opt } from "../../opt.js";
import type { ContactRow } from "./contacts-store.js";

// A contact row as the Messages tab and the `messages` command read it (S2sContactSchema), and the grants rules every
// way of making or changing one shares.

/** The contact as a person reads it; `holdsWake` is whether this sandbox holds the secret that wakes it. */
export const contactView = (row: ContactRow, holdsWake: boolean): S2sContact => ({
    id: row.id,
    address: row.address,
    name: row.name ?? row.document.name,
    host: row.document.host,
    domains: row.document.domains,
    fingerprint: row.document.fingerprint,
    ...opt("recovery", row.document.recovery),
    scope: row.scope,
    state: row.state,
    grants: row.grants,
    ...opt("theirGrants", row.theirGrants),
    holdsWake,
    notices: row.notices,
    origin: row.origin,
    ...opt("note", row.note),
    ...opt("pendingKey", row.pending?.fingerprint),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...opt("lastSeenAt", row.lastSeenAt),
});

/** The grants a scope may hold: operating this sandbox is the sandbox's own to give, never a person's route. */
export const grantsFor = (grants: S2sGrants, scope: S2sContactScope): S2sGrants => (scope.kind === "person" ? { ...grants, operate: false } : grants);

/** The grants after a change: the fields it names replaced, `task: null` taking the task grant away. */
export const grantsAfter = (grants: S2sGrants, change: S2sGrantsUpdate): S2sGrants => {
    const next: S2sGrants = {
        ...grants,
        message: change.message ?? grants.message,
        report: change.report ?? grants.report,
        records: change.records ?? grants.records,
        operate: change.operate ?? grants.operate,
        wake: change.wake ?? grants.wake,
    };
    if (change.task === null) {
        delete next.task;
    } else if (change.task !== undefined) {
        next.task = change.task;
    }
    return next;
};

/** Whether two grant sets say the same. */
export const sameGrants = (left: S2sGrants, right: S2sGrants): boolean => canonicalJson(left) === canonicalJson(right);
