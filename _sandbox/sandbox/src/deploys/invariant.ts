import type { InvariantCheck } from "../invariants/invariants.js";

/*
 * No runtime invariant: the engine's state is .intentic/records/deploys.json, each record parsed on its own against
 * DeployRecordSchema, and the boot's recovery (deploys-engine.ts `recover`) already settles the one state a restart can
 * strand: a record left `running` ends `failed`, and of the records waiting for one stack only the newest is kept. The
 * grants are refused, never read as empty, when their file cannot be read (deploy-grants.ts).
 */

export const owner = "deploys";

export const checks = (): readonly InvariantCheck[] => [];
