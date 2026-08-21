import { mkdtempSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY_FACTS_FILE, type RegistryFile } from "@intentic/registry";
import { describe, expect, it } from "vitest";
import type { ListingProposal, ScanResult } from "./scan.js";
import { writeScanOutputs } from "./outputs.js";

const SCANNED_AT = "2026-08-01T00:00:00.000Z";
const SHA = "9".repeat(40);

const file: RegistryFile = { name: "intentic", plugins: [] };

const proposal: ListingProposal = {
    repo: "acme/incidents",
    entry: {
        name: "acme.incidents",
        kind: "extension",
        trust: "listed",
        description: "Incident triage in the rail.",
        version: "1.0.0",
        source: { source: "github", repo: "acme/incidents", sha: SHA },
    },
};

const result = (over: Partial<ScanResult> = {}): ScanResult => ({
    facts: { scannedAt: SCANNED_AT, entries: [] },
    proposals: [],
    warnings: [],
    ...over,
});

const root = (): string => mkdtempSync(join(tmpdir(), "registry-outputs-"));

describe(`writeScanOutputs`, () => {
    it(`writes the summary when nothing is proposed: the steady state once every tagged repo is listed`, async () => {
        const dir = root();
        await writeScanOutputs(
            dir,
            file,
            result({ facts: { scannedAt: SCANNED_AT, entries: [{ name: "intentic.example", stars: 3, pushedAt: SCANNED_AT }] } }),
        );

        const summary = await readFile(join(dir, ".scan", "summary.md"), "utf8");
        expect(summary).toContain(`Facts refreshed for **1** listed entry`);
        expect(summary).toContain(`**0** new listings proposed`);
        expect(await readdir(join(dir, ".scan"))).toEqual(["summary.md"]);
    });

    it(`materialises a proposal as a complete candidate marketplace.json plus its title and body`, async () => {
        const dir = root();
        await writeScanOutputs(dir, file, result({ proposals: [proposal] }));

        const proposalDir = join(dir, ".scan", "proposals", "acme.incidents");
        expect(await readdir(proposalDir)).toEqual(["body.md", "marketplace.json", "title.txt"].toSorted());
        expect(JSON.parse(await readFile(join(proposalDir, "marketplace.json"), "utf8"))).toEqual({ name: "intentic", plugins: [proposal.entry] });
        expect(await readFile(join(proposalDir, "title.txt"), "utf8")).toBe(`Add acme.incidents (acme/incidents)\n`);
        expect(await readFile(join(proposalDir, "body.md"), "utf8")).toContain(`| Pinned commit | \`${SHA}\` |`);
    });

    it(`rebuilds the output directory so a merged proposal does not linger as a stale branch`, async () => {
        const dir = root();
        await writeScanOutputs(dir, file, result({ proposals: [proposal] }));
        await writeScanOutputs(dir, file, result());

        expect(await readdir(join(dir, ".scan"))).toEqual(["summary.md"]);
    });

    it(`writes the refreshed facts alongside, at the path the registry serves them from`, async () => {
        const dir = root();
        await writeScanOutputs(dir, file, result());

        expect(JSON.parse(await readFile(join(dir, REGISTRY_FACTS_FILE), "utf8"))).toEqual({ scannedAt: SCANNED_AT, entries: [] });
    });
});
