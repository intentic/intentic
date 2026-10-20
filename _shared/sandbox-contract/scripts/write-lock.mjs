#!/usr/bin/env bun
// Rewrites contract.lock.json from the schemas as the source states them: `pnpm --filter @intentic/sandbox-contract
// lock`, which runs this under bun with the `@intentic/src` condition, so every workspace package is read from its own
// src/ and nothing has to be built first. The repository's fixers run the same command wherever a land writes contract
// sources (_tools/scripts/verify/fixers.mjs); the file is `merge=derived`, so no land carries anyone's copy of it.
import { writeFileSync } from "node:fs";
import { currentLock, serializeLock } from "../src/state/contract-lock.ts";

const lock = await currentLock();
writeFileSync(new URL("../contract.lock.json", import.meta.url), serializeLock(lock));
console.log(`contract.lock.json: ${Object.keys(lock).length} entries (schemas, wire manifests and route access)`);
