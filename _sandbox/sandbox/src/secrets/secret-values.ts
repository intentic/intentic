import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ENV_FILE } from "@intentic/scaffold";
import type { SecretVault } from "../capabilities/secret-vault.js";

/* EVERY CREDENTIAL VALUE THIS SANDBOX HOLDS, in one list — what the agent's tool-result masking blanks.
 *
 * Two stores, because the product has two kinds of stored secret and both reach the agent's environment:
 * the capability vault (a connector's token, a browser account's password, an ssh key) and the DevOps
 * `.env` the deploy engine reads. The terminal filter reads the same pair off disk (bin/cleaners.mjs); this is
 * the daemon's own view of it, which needs no parsing of the vault file because the vault is right here.
 *
 * VALUES ONLY, never keys. A key name is not a secret, and masking it would blank ordinary prose — a file that
 * mentions `GITHUB_TOKEN` is documentation, not a leak.
 *
 * Read on each call rather than cached: a credential connected mid-turn must be masked in the very next tool
 * result, and these are two small files against a model round-trip.
 */
export const secretValuesOf = (vault: SecretVault, desiredStateRepo: () => string) => async (): Promise<readonly string[]> => {
    const [stored, env] = await Promise.all([
        vault.values().catch(() => [] as readonly string[]),
        readFile(join(desiredStateRepo(), ENV_FILE), "utf8").catch(() => ""),
    ]);
    // parseEnv answers a Dict — every key it enumerates has a string value, which is all this reads.
    return [...stored, ...Object.values(parseEnv(env) as Record<string, string>)];
};
