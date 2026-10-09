#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { chromium } from "playwright";
import { attribute } from "../mobile/attribution.js";
import { buildDemo } from "../mobile/build.js";
import { median } from "../mobile/measures.js";
import { serveBuild } from "../mobile/serve.js";
import { type Measured, SCENARIOS, type Scenario } from "./chat-scenarios.js";

const USAGE = `perf:chat [--only a,b] [--rows N] [--runs N] [--phone] [--cpu N] [--stream-ms N] [--profile] [--dist DIR] [--out DIR] [--json]

  Times what a long conversation costs to live with: the demo (_site/demo) built for production, served locally, one
  fixture chat inflated to --rows rows, driven in Chromium on a 1440×900 desktop (--phone: the phone lab's Galaxy S10,
  CPU slowed 4×). Reports each scenario's median over --runs. A lab, never a gate: timings move with the machine and its
  load, so compare two builds (--dist) measured on the same machine in the same sitting.

  --rows N       the chat's size in rows (default 2000; the fixture's 7 rows copied, every other answer with markdown)
  --stream-ms N  how long the streamed turn runs (default 8000)
  --profile      CPU-profile each scenario's measured action and name where its time went, by source

  scenarios:
${SCENARIOS.map((scenario) => `    ${scenario.name.padEnd(8)} ${scenario.about}`).join("\n")}
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
const phone = args.includes("--phone");
const runs = whole("--runs", 1);
const cpu = whole("--cpu", phone ? 4 : 1);
const rows = whole("--rows", 2000);
const streamMs = whole("--stream-ms", 8000);
const profiling = args.includes("--profile");
const json = args.includes("--json");
const scratch = join(tmpdir(), "intentic-perf-chat");
const out = flag("--out") ?? join(scratch, "profiles");

const repo = repoRoot(import.meta.dirname);
const say = (line: string): void => {
    if (!json) {
        process.stdout.write(`${line}\n`);
    }
};

const dist = flag("--dist") ?? (say(`building the demo for production…`), await buildDemo(repo, join(scratch, "demo")));
const server = await serveBuild(dist);
const browser = await chromium.launch({ channel: "chromium" });

const results: Record<string, Record<string, number>> = {};
try {
    say(`${phone ? "phone: 412×869 touch" : "desktop: 1440×900"}, CPU ×${cpu}; chat of ${rows} rows; ${runs} run(s) each\n`);
    for (const scenario of selected) {
        const measured: Measured[] = [];
        for (let run = 0; run < runs; run += 1) {
            measured.push(
                await scenario.run({
                    browser,
                    origin: server.origin,
                    cpu,
                    phone,
                    copies: Math.max(1, Math.round(rows / 7)),
                    streamMs,
                    profile: profiling,
                }),
            );
        }
        const names = Object.keys(measured[0]?.numbers ?? {});
        const numbers = Object.fromEntries(names.map((name) => [name, median(measured.map((one) => one.numbers[name] ?? 0))]));
        results[scenario.name] = numbers;
        say(
            `${scenario.name.padEnd(8)} ${Object.entries(numbers)
                .map(([name, value]) => `${name} ${value}`)
                .join("  ")}`,
        );
        const profile = measured[0]?.profile;
        if (profile !== undefined) {
            mkdirSync(out, { recursive: true });
            const file = join(out, `${scenario.name}.cpuprofile`);
            writeFileSync(file, JSON.stringify(profile));
            const where = attribute(profile, join(dist, "assets"), 12);
            say(`    profile ${file}: ${where.totalMs - where.idleMs}ms busy, ${where.engineMs}ms outside JS (parse, style, layout, paint)`);
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
    process.stdout.write(`${JSON.stringify({ phone, cpu, rows, runs, results }, null, 2)}\n`);
}
