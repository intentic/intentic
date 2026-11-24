import { z } from "zod";

/* Run-outs shared across sandboxes (docs/architecture/account-routing.md): one sandbox says a provider account's pool
   ran out, the owner's other sandboxes signed in to the same account hear it. The account is named only by a hash of
   the provider's own account id (`fingerprint`), never the id or a credential, and no usage reading travels. */

// sha256 hex of `provider \0 id(s)`, as the daemon's pool-fingerprint.ts makes it.
const PoolFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const PoolSignalSchema = z.object({
    fingerprint: PoolFingerprintSchema,
    // The pool that ran out, as the provider's reading keys it (`seven_day`), or `*` for the whole allowance.
    pool: z.string().min(1).max(120),
    // Epoch ms the provider first refused.
    ranOutAt: z.number().int().nonnegative(),
    // Epoch seconds it said to try again, where it named a time.
    resetsAt: z.number().int().nonnegative().optional(),
});
export type PoolSignal = z.infer<typeof PoolSignalSchema>;
// `POST /pool-signals/report`: the latest run-out per fingerprint and pool, from the calling sandbox.
export const PoolSignalBodySchema = PoolSignalSchema;
// `POST /pool-signals/read`: the live run-outs for the accounts the calling sandbox holds, from its owner's other
// sandboxes. Bounded: a sandbox holds a handful of accounts, and the bound keeps one call one indexed read.
export const POOL_SIGNALS_MAX_FINGERPRINTS = 32;
export const PoolSignalsBodySchema = z.object({ fingerprints: z.array(PoolFingerprintSchema).max(POOL_SIGNALS_MAX_FINGERPRINTS) });
export const PoolSignalsSchema = z.object({ signals: z.array(PoolSignalSchema) });
export type PoolSignals = z.infer<typeof PoolSignalsSchema>;
