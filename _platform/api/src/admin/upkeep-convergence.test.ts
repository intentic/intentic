import type { HostReport } from "@intentic/api-contract";
import { convergenceDigestLines, newerVersion, upkeepConvergence } from "./upkeep-convergence.js";

const report = (machine: string, at: string, upkeep?: HostReport[`upkeep`], env?: string): HostReport => ({
    source: `agent`,
    machine,
    os: `windows`,
    stage: `done`,
    checks: [],
    at,
    ...(env === undefined ? {} : { env }),
    ...(upkeep === undefined ? {} : { upkeep }),
});

describe(`upkeepConvergence`, () => {
    it(`counts each machine once, by its newest report, per agent version, newest version first`, () => {
        const rows = upkeepConvergence([
            report(`rog`, `2026-10-05T10:00:00Z`, { found: 9, fixed: 0, skipped: 2, agentVersion: `1.329.0` }),
            report(`rog`, `2026-10-06T10:00:00Z`, { found: 5, fixed: 5, skipped: 1, agentVersion: `1.330.0`, kinds: { "stale-pairing": 3, "retired-generation": 2 } }),
            report(`rog`, `2026-10-06T09:00:00Z`, { found: 0, fixed: 0, skipped: 0, agentVersion: `1.330.0` }, `archlinux`),
            report(`omen`, `2026-10-06T08:00:00Z`, { found: 1, fixed: 1, skipped: 0, agentVersion: `1.329.0` }),
            report(`old`, `2026-10-06T08:00:00Z`),
        ]);
        expect(rows).toEqual([
            { version: `1.330.0`, machines: 2, holding: 1, found: 5, fixed: 5, kinds: { "stale-pairing": 3, "retired-generation": 2 } },
            { version: `1.329.0`, machines: 1, holding: 0, found: 1, fixed: 1, kinds: {} },
        ]);
    });

    it(`raises one digest line only for machines on the newest agent that still hold leftovers`, () => {
        const rows = upkeepConvergence([report(`rog`, `2026-10-06T10:00:00Z`, { found: 5, fixed: 4, skipped: 1, agentVersion: `1.330.0`, kinds: { "second-ic": 1 } })]);
        const lines = convergenceDigestLines(rows);
        expect(lines).toHaveLength(1);
        expect(lines[0]?.title).toBe(`1 of 1 machine on agent 1.330.0 still hold leftovers their upkeep could not clear`);
        expect(lines[0]?.detail).toContain(`second-ic 1`);
        expect(convergenceDigestLines(upkeepConvergence([report(`rog`, `2026-10-06T10:00:00Z`, { found: 2, fixed: 2, skipped: 0, agentVersion: `1.330.0` })]))).toEqual([]);
    });

    it(`orders versions by their numbers, not as text`, () => {
        expect(newerVersion(`1.330.0`, `1.99.9`)).toBeGreaterThan(0);
        expect(newerVersion(`1.329.2`, `1.330.0`)).toBeLessThan(0);
        expect(newerVersion(`1.330.0`, `1.330.0`)).toBe(0);
    });
});
