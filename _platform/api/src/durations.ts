import { SANDBOX_RECOVERY_DAYS } from "@intentic/api-contract";

/* Every retention sweep, admin rollup, idle collection and alert latch here is a multiple of one of these, and each module had spelled its own out. */
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/* How long a removal stays reversible. One window for both halves of a deletion — the sandbox's identity (a
 * SandboxTrash row) and the disk under it (a held-back Fly app) — so neither can outlive the other. The number
 * itself is the contract's, since the browser promises it before the sweep has to keep it. */
export const RECOVERY_WINDOW_MS = SANDBOX_RECOVERY_DAYS * DAY_MS;
