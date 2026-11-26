// WORK AN EXTENSION HOLDS IN FLIGHT (2026-11-26): what `api.work.hold(label)` registers, counted by the one answer to "is
// the sandbox busy" (bootstrap/working-now.ts) beside turns, lands and workflows, so the machine stays awake and an
// update or a restart waits while an extension's probe run or deploy is under way, as for an agent's turn. A hold lives
// exactly as long as the request that made it stays open (own.routes.ts, POST /extension/work/hold): the extension
// letting go, its backend host dying, or its process exiting all close the connection, which releases the hold, so
// there is no lease to renew and nothing a dead backend can leave behind. A daemon restart ends every hold with the
// connections, and the runtime holds again on the new daemon while its holder still wants it.

export interface ExtensionHold {
    // The extension, as publisher.name.
    readonly extension: string;
    readonly label: string;
    readonly since: number;
}

// allow(module-state): the holds of this daemon's open connections, which end with the process
const holds = new Map<symbol, ExtensionHold>();

/** Holds work for `extension`; answers the release, which is safe to call twice. */
export const holdExtensionWork = (extension: string, label: string, now = Date.now()): (() => void) => {
    const key = Symbol(label);
    holds.set(key, { extension, label, since: now });
    return () => void holds.delete(key);
};

/** Every hold standing now, oldest first. */
export const extensionHolds = (): readonly ExtensionHold[] => [...holds.values()];

/** How a hold is named to whoever waits on it: the card asking to restart, the update's countdown. */
export const holdName = (hold: Pick<ExtensionHold, "extension" | "label">): string => `${hold.extension}: ${hold.label}`;
