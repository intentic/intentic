#!/usr/bin/env node
// Whether a home conversation costs what an ordinary one does, per turn, off this sandbox's spend ledger
// (home-cost.ts does the arithmetic, kept separate so its test can import it).
// pnpm --filter @intentic/sandbox bench:home
// pnpm --filter @intentic/sandbox bench:home --days 14 --budget 150000 --json
// `--ledger` names another usage.jsonl; `--budget` is the sandbox's `homeFreshOver`, which the over-budget line reads.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { errorMessage } from "@intentic/base/errors";
import { UsageTurnSchema, type UsageTurn } from "@intentic/sandbox-contract/schemas/providers/usage";
import { homeCost, type Spread } from "./home-cost.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
};
const ledger = flag("ledger") ?? join(HISTORY_ROOT, "usage.jsonl");
const days = Number(flag("days") ?? "14");
const budget = Number(flag("budget") ?? "150000");
// The ledger files each turn under its UTC day (`day`), so the window opens on one too.
const sinceUtcDay = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

let rows: UsageTurn[];
try {
    rows = readFileSync(ledger, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
            const parsed = UsageTurnSchema.safeParse(JSON.parse(line));
            return parsed.success ? [parsed.data] : [];
        });
} catch (error) {
    process.stderr.write(`cannot read the spend ledger at ${ledger}: ${errorMessage(error)}\n`);
    process.exit(1);
}

const cost = homeCost(rows, { since: sinceUtcDay, budget });
if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(cost, null, 2)}\n`);
    process.exit(0);
}

const tokens = (value: number | undefined): string => (value === undefined ? "-" : `${Math.round(value / 1000)}k`);
const line = (label: string, spread: Spread): string =>
    `  ${label.padEnd(22)} ${String(spread.turns).padStart(6)} turns  ${String(spread.conversations).padStart(5)} chats  ` +
    `$/turn mean ${spread.costMean.toFixed(2).padStart(6)}  p50 ${spread.costP50.toFixed(2).padStart(6)}  p90 ${spread.costP90.toFixed(2).padStart(6)}  ` +
    `context p50 ${tokens(spread.contextP50).padStart(5)}  p90 ${tokens(spread.contextP90).padStart(5)}`;

process.stdout.write(`spend ledger ${ledger}, priced turns ${cost.from ?? "-"} → ${cost.to ?? "-"} (last ${days} days)\n`);
process.stdout.write(`${line("home conversations", cost.home)}\n${line("every other", cost.other)}\n`);
process.stdout.write(`  a home's turn costs ${cost.ratio === undefined ? "- (not enough turns yet)" : `${cost.ratio.toFixed(2)}×`} an ordinary one's\n`);
const why = Object.entries(cost.fresh.byWhy).map(([reason, count]) => `${reason} ${count}`).join(", ");
process.stdout.write(`\nfresh starts (homeFresh): ${why === "" ? "none yet" : why}\n${line("opened fresh", cost.fresh.spread)}\n`);
process.stdout.write(`${line(`resumed past ${tokens(budget)}`, cost.overBudget)}\n`);
