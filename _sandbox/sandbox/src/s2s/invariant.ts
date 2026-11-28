import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: the identity keeps two files and no copy of either in memory to drift. The key file is written
 * whole under its own lock (a key set made, retired or vouched for in one step), and every reader derives the key sets
 * from its seeds afresh, refusing one whose seeds no longer give the fingerprint beside them. The signed document is a
 * cache keyed by every fact it carries, so a changed fact signs a new one; the domains file is advisory, and a domain is
 * listed only while its last check matched the current key and host.
 */

export const owner = "s2s";

export const checks = (): readonly InvariantCheck[] => [];
