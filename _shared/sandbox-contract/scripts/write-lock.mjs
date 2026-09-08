#!/usr/bin/env node
// Regenerates contract.lock.json from the built dist. Run as `pnpm --filter @intentic/sandbox-contract lock`, which
// builds via `tsgo -b` first: a plain `tsgo` would compile only this package and reuse a stale dependency dist.
import { writeFileSync } from "node:fs";
import { currentLock, serializeLock } from "../dist/state/contract-lock.js";

const lock = currentLock();
writeFileSync(new URL("../contract.lock.json", import.meta.url), serializeLock(lock));
console.log(`contract.lock.json: ${Object.keys(lock).length} exported schemas`);
