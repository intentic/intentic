#!/usr/bin/env node
/* Regenerate contract.lock.json from the built dist: the committed half of the pair contract-lock.ts
 * explains. Run as `pnpm --filter @intentic/sandbox-contract lock`, which builds first so the lock is always
 * cut from the code as it stands, never from a stale dist.
 *
 * That build is `tsgo -b`, which follows the project references, and the `-b` is the whole point: most of this
 * surface is schemas re-exported from @intentic/extension-manifest, and a plain `tsgo` compiles THIS package
 * only: it reads the dependency's last emitted dist and asks no questions. So the lock could be regenerated,
 * committed, and still describe a contract nobody had exported for two commits: an extension manifest's `when`
 * stayed an object here long after the code made it a string expression, and every `.describe()` the
 * contribution points had grown was missing. Nothing said a word until the lock test ran against a tree the
 * the declarations emit had built properly, by which point the drift read as a break arriving with no declaration. */
import { writeFileSync } from "node:fs";
import { currentLock, serializeLock } from "../dist/contract-lock.js";

const lock = currentLock();
writeFileSync(new URL("../contract.lock.json", import.meta.url), serializeLock(lock));
console.log(`contract.lock.json: ${Object.keys(lock).length} exported schemas`);
