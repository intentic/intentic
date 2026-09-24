#!/usr/bin/env node
import { availableParallelism, cpus } from "node:os";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { conclude, type Reading } from "../baseline.js";
import { countInstructions, NODE_FLAGS, valgrindVersion } from "./cachegrind.js";
import { spread } from "./spread.js";

const USAGE = `perf:instr [--update] [--only a,b] [--runs N] [--jobs N]

  Counts the instructions each scenario's work executes, under Valgrind with node --predictable, and judges them
  against baselines/instr.json. --update re-records it; --runs N measures each scenario N times and reports the spread.
`;

const here = import.meta.dirname;
const packageDir = join(here, "..", "..");
const baselinePath = join(packageDir, "baselines", "instr.json");
const probe = join(here, "counted-process.js");

// Relative, and about 500 times the run-to-run spread (single-digit parts per million); a CPU with other features moves
// a count by up to about 1%, which is why the baseline is recorded on the host that judges it.
const TOLERANCE = 0.005;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
};
if (args.includes("--help")) {
    process.stdout.write(USAGE);
    process.exit(0);
}

const version = valgrindVersion();
if (version === undefined) {
    process.stderr.write(
        "perf:instr needs Valgrind on PATH (Linux: apt-get install valgrind). It counts guest instructions, so there is no fallback.\n",
    );
    process.exit(2);
}

const available = readdirSync(join(here, "scenarios"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.slice(0, -".js".length))
    .toSorted();
const only = flag("--only")?.split(",");
const unknown = only?.filter((name) => !available.includes(name)) ?? [];
if (unknown.length > 0) {
    process.stderr.write(`unknown scenario ${unknown.join(", ")}; have ${available.join(", ")}\n`);
    process.exit(2);
}
const names = only ?? available;
const runs = Number(flag("--runs") ?? "1");
const jobs = Number(flag("--jobs") ?? Math.max(1, Math.floor(availableParallelism() / 2)));

// Each measurement is two processes, setup alone and setup + work; the work is their difference.
const measure = async (name: string): Promise<number> => {
    const [setup, full] = await Promise.all([
        countInstructions(probe, [name, "setup"], packageDir),
        countInstructions(probe, [name, "full"], packageDir),
    ]);
    return full - setup;
};

const queue = names.flatMap((name) => Array.from({ length: runs }, () => name));
const counts = new Map<string, number[]>();
const started = Date.now();
// Two processes per measurement, so half the jobs' worth of measurements run at once.
const workers = Array.from({ length: Math.max(1, Math.ceil(jobs / 2)) }, async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        const instructions = await measure(name);
        counts.set(name, [...(counts.get(name) ?? []), instructions]);
        process.stderr.write(`  ${name}: ${instructions.toLocaleString("en-US")}\n`);
    }
});
await Promise.all(workers);
process.stderr.write(`measured ${names.length} scenarios × ${runs} in ${((Date.now() - started) / 1000).toFixed(0)}s\n\n`);

if (runs > 1) {
    for (const name of names) {
        const { min, max, relative } = spread(counts.get(name)!);
        process.stdout.write(
            `${name}: ${min.toLocaleString("en-US")} … ${max.toLocaleString("en-US")} (spread ${(relative * 1e6).toFixed(1)} ppm)\n`,
        );
    }
    process.stdout.write("\n");
}

// The first run of each is the reading: `--runs` is a check on the instrument, not a sample to average.
const measured: Record<string, Reading> = Object.fromEntries(names.map((name) => [name, { instructions: counts.get(name)![0]! }]));
const outcome = conclude({
    path: baselinePath,
    measured,
    host: { node: process.version, flags: NODE_FLAGS.join(" "), valgrind: version, arch: process.arch, cpu: cpus()[0]?.model.trim() ?? "unknown" },
    tolerance: () => TOLERANCE,
    update: args.includes("--update"),
    complete: only === undefined,
    binding: ["node", "flags", "arch"],
    rerecord: `pnpm perf:instr --update${only === undefined ? "" : ` --only ${only.join(",")}`}`,
});
process.stdout.write(`${outcome.text}\n`);
process.exit(outcome.ok ? 0 : 1);
