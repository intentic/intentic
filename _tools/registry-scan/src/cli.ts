#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REGISTRY_FILE, RegistryFileSchema } from "@intentic/registry";
import { githubReader } from "./github.js";
import { scanSummary, writeScanOutputs } from "./outputs.js";
import { scanRegistry } from "./scan.js";

/* The scan's entry point, run from a checkout of the registry repo itself. Reads the environment, scans, and
 * hands the result to writeScanOutputs; the workflow that calls it only moves the resulting files around. */

const main = async (): Promise<void> => {
    const token = process.env[`GITHUB_TOKEN`];
    if (token === undefined || token === ``) {
        throw new Error(`GITHUB_TOKEN is required — the search and contents endpoints are rate-limited to nothing without it`);
    }
    // Passed in rather than read from the clock so a re-run against a fixed input produces a fixed output.
    const scannedAt = process.env[`SCANNED_AT`] ?? new Date().toISOString();
    const root = process.env[`REGISTRY_DIR`] ?? process.cwd();

    const file = RegistryFileSchema.parse(JSON.parse(await readFile(join(root, REGISTRY_FILE), "utf8")));
    const result = await scanRegistry(file, githubReader(token), scannedAt);

    await writeScanOutputs(root, file, result);
    process.stdout.write(`${scanSummary(result)}\n`);
};

await main();
