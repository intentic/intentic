#!/usr/bin/env node
// Regenerate contract.lock.json from the built dist — the committed half of the pair contract-lock.ts
// explains. Run as `pnpm --filter @intentic/sandbox-contract lock`, which builds first so the lock is always
// cut from the code as it stands, never from a stale dist.
import { writeFileSync } from "node:fs";
import { currentLock, serializeLock } from "../dist/contract-lock.js";

const lock = currentLock();
writeFileSync(new URL("../contract.lock.json", import.meta.url), serializeLock(lock));
console.log(`contract.lock.json: ${Object.keys(lock).length} exported schemas`);
