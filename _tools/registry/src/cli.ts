#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { REGISTRY_FACTS_FILE, REGISTRY_FILE, RegistryFileSchema } from "@intentic/registry";
import { githubReader } from "./github.js";
import { type ListingProposal, scanRegistry } from "./scan.js";

/* The scan's entry point, run from a checkout of the registry repo itself.
 *
 * Everything that needs to understand JSON happens here; the workflow that calls it only moves files and
 * talks to `gh`. So a proposal is materialised as a COMPLETE candidate marketplace.json with exactly one
 * entry added, next to the pull request's title and body — the workflow copies the file over, commits, opens
 * the pull request, and never has to edit JSON in bash. */

const OUT_DIR = ".scan";
const INDENT = 4;

const writeJson = async (path: string, value: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, INDENT)}\n`, "utf8");
};

const prBody = (proposal: ListingProposal): string =>
    [
        `Found by the nightly scan: [\`${proposal.repo}\`](https://github.com/${proposal.repo}) carries the \`intentic-extension\` topic and a manifest that parses.`,
        ``,
        `| | |`,
        `| --- | --- |`,
        `| Extension id | \`${proposal.entry.name}\` |`,
        `| Version | \`${proposal.entry.version}\` |`,
        `| Pinned commit | \`${proposal.entry.source.sha}\` |`,
        ``,
        `**What to check before merging.** The manifest parses and the publisher does not collide with an`,
        `existing listing — the scan verified both, and nothing else. Review checks the pointer, not the code:`,
        ``,
        `- [ ] The commit resolves and the entry bundle exists at it.`,
        `- [ ] The description matches what the manifest actually contributes.`,
        `- [ ] The publisher slug belongs to whoever owns this repository.`,
        ``,
        `Merging lists it as \`trust: "listed"\` — the pointer resolves, and that is the whole claim. Promoting`,
        `to \`verified\` is a separate edit by somebody who has read the source at this sha.`,
    ].join("\n");

const summary = (facts: number, proposals: ListingProposal[], warnings: string[]): string =>
    [
        `# Registry scan`,
        ``,
        `- Facts refreshed for **${facts}** listed ${facts === 1 ? "entry" : "entries"}`,
        `- **${proposals.length}** new ${proposals.length === 1 ? "listing" : "listings"} proposed`,
        ...(proposals.length > 0 ? [``, ...proposals.map((proposal) => `  - \`${proposal.entry.name}\` from ${proposal.repo}`)] : []),
        ...(warnings.length > 0 ? [``, `## Skipped and needing a look`, ``, ...warnings.map((warning) => `- ${warning}`)] : []),
    ].join("\n");

const main = async (): Promise<void> => {
    const token = process.env[`GITHUB_TOKEN`];
    if (token === undefined || token === ``) {
        throw new Error(`GITHUB_TOKEN is required — the search and contents endpoints are rate-limited to nothing without it`);
    }
    // Passed in rather than read from the clock so a re-run against a fixed input produces a fixed output.
    const scannedAt = process.env[`SCANNED_AT`] ?? new Date().toISOString();
    const root = process.env[`REGISTRY_DIR`] ?? process.cwd();

    const file = RegistryFileSchema.parse(JSON.parse(await readFile(join(root, REGISTRY_FILE), "utf8")));
    const { facts, proposals, warnings } = await scanRegistry(file, githubReader(token), scannedAt);

    await writeJson(join(root, REGISTRY_FACTS_FILE), facts);

    // Rebuilt every run: a proposal that has since been merged or closed must not linger as a stale branch.
    const out = join(root, OUT_DIR);
    await rm(out, { recursive: true, force: true });
    for (const proposal of proposals) {
        const dir = join(out, "proposals", proposal.entry.name);
        await writeJson(join(dir, "marketplace.json"), { ...file, plugins: [...file.plugins, proposal.entry] });
        await writeFile(join(dir, "title.txt"), `Add ${proposal.entry.name} (${proposal.repo})\n`, "utf8");
        await writeFile(join(dir, "body.md"), `${prBody(proposal)}\n`, "utf8");
    }

    await writeFile(join(out, "summary.md"), `${summary(facts.entries.length, proposals, warnings)}\n`, "utf8");
    process.stdout.write(`${summary(facts.entries.length, proposals, warnings)}\n`);
};

await main();
