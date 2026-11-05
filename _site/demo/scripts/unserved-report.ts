// Whether src/unserved.ts still accounts for the whole contract: every route the fixture daemon neither serves nor
// lists there, and every route listed there that it now serves or the contract dropped. A report, not a gate: the demo
// answers an unlisted route with the same 404 a listed one gets, only without the reason, so a gap here is bookkeeping
// to catch up on, and as a typecheck it failed 15 main runs from 2026-10-23 to 11-05. Prints each gap as a GitHub
// `::warning` and, when $GITHUB_STEP_SUMMARY is set, as a table there; always exits 0.
// Run: `node scripts/unserved-report.ts` from _site/demo. The vendored extensions are not needed: no route table
// reads them.

import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle, loaded, stubBrowser } from "./node-bundle.ts";

const ENTRIES = {
    daemon: `src/daemon.ts`,
    procedures: `src/daemon/procedures.ts`,
    raw: `src/daemon/raw.ts`,
    unserved: `src/unserved.ts`,
    contract: `@intentic/sandbox-contract`,
    rawRoutes: `@intentic/sandbox-contract/protocol/raw/raw-routes`,
} as const;

const report = async (): Promise<{ readonly unlisted: string[]; readonly stale: string[]; readonly contract: number }> => {
    stubBrowser();
    const out = await mkdtemp(join(tmpdir(), `demo-unserved-`));
    try {
        await bundle(out, ENTRIES);
        const { sockets } = await loaded<typeof import("../src/daemon.ts")>(out, `daemon`);
        const { procedures } = await loaded<typeof import("../src/daemon/procedures.ts")>(out, `procedures`);
        const { raw } = await loaded<typeof import("../src/daemon/raw.ts")>(out, `raw`);
        const { UNSERVED } = await loaded<typeof import("../src/unserved.ts")>(out, `unserved`);
        const { SANDBOX_ROUTE_NAMES } = await loaded<typeof import("@intentic/sandbox-contract")>(out, `contract`);
        const { RAW_ROUTE_LIST } = await loaded<typeof import("@intentic/sandbox-contract/protocol/raw/raw-routes")>(out, `rawRoutes`);

        const contract = new Set<string>([...SANDBOX_ROUTE_NAMES, ...RAW_ROUTE_LIST.map((route) => route.name)]);
        const served = new Set<string>([
            ...Object.entries(procedures).flatMap(([group, handlers]) => Object.keys(handlers).map((name) => `${group}.${name}`)),
            ...Object.keys(raw),
            ...Object.keys(sockets),
        ]);
        const listed = Object.keys(UNSERVED);
        return {
            unlisted: [...contract].filter((route) => !served.has(route) && !(route in UNSERVED)).toSorted(),
            stale: listed.filter((route) => served.has(route) || !contract.has(route)).toSorted(),
            contract: contract.size,
        };
    } finally {
        await rm(out, { recursive: true, force: true });
    }
};

const { unlisted, stale, contract } = await report();
const FILE = `_site/demo/src/unserved.ts`;
for (const route of unlisted) {
    console.log(`::warning file=${FILE}::${route} is neither served by the demo's fixture daemon nor listed in unserved.ts`);
}
for (const route of stale) {
    console.log(`::warning file=${FILE}::${route} is listed in unserved.ts but the fixture now serves it or the contract dropped it`);
}
console.log(`[demo] ${contract} contract routes: ${unlisted.length} neither served nor listed, ${stale.length} listed but stale.`);

const summary = process.env[`GITHUB_STEP_SUMMARY`];
if (summary !== undefined && summary !== ``) {
    const rows = [...unlisted.map((route) => `| \`${route}\` | neither served nor listed |`), ...stale.map((route) => `| \`${route}\` | listed, but served or dropped |`)];
    const body =
        rows.length === 0
            ? `### Demo route ledger\n\nAll ${contract} contract routes are served by the demo or listed in \`${FILE}\`.\n`
            : `### Demo route ledger\n\n${rows.length} of ${contract} contract routes are out of step with \`${FILE}\`: serve each in \`_site/demo/src/daemon/\` or give it a reason in the list.\n\n| Route | State |\n| --- | --- |\n${rows.join(`\n`)}\n`;
    await appendFile(summary, body);
}

// The fixture's modules start timers as they load (a recorded turn's clock, the board's ticks), so the loop never
// drains by itself; smoke-daemon.ts ends the same way.
process.exit(0);
