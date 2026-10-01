import { z } from "zod";

// What a daemon says it is on its announce and its adoption: a release version, short. Anything else is not stored (the
// call itself still counts), since a stale or made-up version is worse than none.
export const DaemonVersionSchema = z
    .string()
    .max(64)
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
