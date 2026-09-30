#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { chromium } from "playwright";
import { attribute } from "./attribution.js";
import { buildDemo } from "./build.js";
import { median } from "./measures.js";
import { SCENARIOS, type Measured, type Scenario } from "./scenarios.js";
import { serveBuild } from "./serve.js";
import { wireClaim } from "./wire.js";

const USAGE = `perf:mobile [--only a,b] [--runs N] [--cpu N] [--rows N] [--replay] [--profile] [--dist DIR] [--out DIR] [--json]

  Times what the editor costs a phone: the demo (_site/demo) built for production, served locally, and driven in
  Chromium as a Galaxy S10-class Android (412×869 touch viewport) with its CPU slowed --cpu times (default 4). Reports
  web vitals (first paint, INP and its parts, layout shift), long tasks and long frames, per scenario, as the median of
  --runs runs. A lab for finding and checking a phone's slowness, never a gate: timings move with the machine, so compare
  runs taken on the same one (--dist measures a build you made, e.g. at another revision).

  --rows N     the long conversation's size, in rows (default 140; the fixture's 7 rows copied)
  --replay     run the app's real PostHog SDK and session recorder against a local stand-in
  --profile    CPU-profile each scenario's measured action and name where its time went, by source
  --out DIR    where profiles are written (default: a temp directory), each a .cpuprofile DevTools opens

  scenarios:
${SCENARIOS.map((scenario) => `    ${scenario.name.padEnd(12)} ${scenario.about}`).join("\n")}
`;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
};
if (args.includes("--help")) {
    process.stdout.write(USAGE);
    process.exit(0);
}
const whole = (name: string, fallback: number): number => {
    const value = Number(flag(name) ?? fallback);
    if (!Number.isInteger(value) || value < 1) {
        process.stderr.write(`${name} takes a whole number of at least 1, not ${flag(name)}\n`);
        process.exit(2);
    }
    return value;
};
const only = flag("--only")?.split(",");
const unknown = only?.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name)) ?? [];
if (unknown.length > 0) {
    process.stderr.write(`unknown scenario ${unknown.join(", ")}; have ${SCENARIOS.map((scenario) => scenario.name).join(", ")}\n`);
    process.exit(2);
}
const selected: readonly Scenario[] = only === undefined ? SCENARIOS : SCENARIOS.filter((scenario) => only.includes(scenario.name));
const runs = whole("--runs", 1);
const cpu = whole("--cpu", 4);
const rows = whole("--rows", 140);
const replay = args.includes("--replay");
const profiling = args.includes("--profile");
const json = args.includes("--json");
const scratch = join(tmpdir(), "intentic-perf-mobile");
const out = flag("--out") ?? join(scratch, "profiles");

const repo = repoRoot(import.meta.dirname);
const say = (line: string): void => {
    if (!json) {
        process.stdout.write(`${line}\n`);
    }
};

const dist = flag("--dist") ?? (say(`building the demo for production…`), await buildDemo(repo, join(scratch, "demo")));
const server = await serveBuild(dist, "/demo/", replay ? wireClaim(repo) : undefined);
const browser = await chromium.launch({ channel: "chromium" });

const results: Record<string, { numbers: Record<string, number>; notes: readonly string[] }> = {};
try {
    say(`phone: 412×869 touch, CPU ×${cpu}${replay ? ", session replay on" : ""}; long chat ${rows} rows; ${runs} run(s) each\n`);
    for (const scenario of selected) {
        const measured: Measured[] = [];
        for (let run = 0; run < runs; run += 1) {
            measured.push(await scenario.run({ browser, origin: server.origin, cpu, replay, copies: Math.max(1, Math.round(rows / 7)), profile: profiling }));
        }
        const names = Object.keys(measured[0]?.numbers ?? {});
        const numbers = Object.fromEntries(names.map((name) => [name, median(measured.map((one) => one.numbers[name] ?? 0))]));
        results[scenario.name] = { numbers, notes: measured[0]?.notes ?? [] };
        say(`${scenario.name}  ${Object.entries(numbers).map(([name, value]) => `${name} ${value}`).join("  ")}`);
        for (const note of measured[0]?.notes ?? []) {
            say(`    ${note}`);
        }
        const profile = measured[0]?.profile;
        if (profile !== undefined) {
            mkdirSync(out, { recursive: true });
            const file = join(out, `${scenario.name}.cpuprofile`);
            writeFileSync(file, JSON.stringify(profile));
            const where = attribute(profile, join(dist, "assets"), 12);
            say(`    profile ${file}: ${where.totalMs - where.idleMs}ms busy, ${where.engineMs}ms outside JS (parse, style, layout, paint)`);
            for (const [area, ms] of where.byArea) {
                say(`      ${String(ms).padStart(6)}ms  ${area}`);
            }
            say(`    heaviest functions:`);
            for (const [name, ms] of where.byFunction) {
                say(`      ${String(ms).padStart(6)}ms  ${name}`);
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
if (json) {
    process.stdout.write(`${JSON.stringify({ cpu, rows, replay, runs, results }, null, 2)}\n`);
}
