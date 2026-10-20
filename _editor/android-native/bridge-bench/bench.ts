// The bridge bench's driver: every mode's cold start and per-call times, on one phone, taken in rotation so no mode
// always runs last on a warmer phone.
//
//   node _editor/android-native/bridge-bench/bench.ts --serial <adb serial> [--starts 10] [--call-runs 5]
//       [--modes jni,jna-direct,jna-interface,uniffi] [--no-compile]
//
// Install the app first (README.md, Commands). The tables print as markdown, and every run lands in the system temp
// directory's intentic-bridge-bench/results-<time>.json.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PACKAGE = `dev.intentic.bridgebench`;
const TAG = `BridgeBench`;
const MODES = [`jni`, `jna-direct`, `jna-interface`, `uniffi`];
const OPS = [`noop`, `echo`, `bytes`, `echo-checked`];

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
};
const serial = option(`serial`) ?? process.env[`ANDROID_SERIAL`];
if (serial === undefined) {
    throw new Error(`name the phone with --serial`);
}
const starts = Number(option(`starts`) ?? `10`);
const callRuns = Number(option(`call-runs`) ?? `5`);
const modes = (option(`modes`) ?? MODES.join(`,`)).split(`,`);

// A hand-run script plain node loads from the tree: @intentic/base's runBounded loads only built or under bun. adb is the
// one child, and every call has a deadline.
const adb = (...rest: string[]): string =>
    execFileSync(process.env[`ADB`] ?? `adb`, [`-s`, serial, ...rest], { encoding: `utf8`, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
const shell = (command: string): string => adb(`shell`, command);

// The bench's own lines, from one `adb logcat` stream filtered to its tag. Dumping the log after each launch lost a
// line: during a launch the S10's log daemon, flooded by the system's own logging, kept about a second of history.
const logged: string[] = [];
const stream = spawn(process.env[`ADB`] ?? `adb`, [`-s`, serial, `logcat`, `-T`, `1`, `-s`, TAG], { stdio: [`ignore`, `pipe`, `ignore`] });
let partial = ``;
stream.stdout.setEncoding(`utf8`);
stream.stdout.on(`data`, (chunk: string) => {
    const parts = `${partial}${chunk}`.split(/\r?\n/u);
    partial = parts.pop() ?? ``;
    logged.push(...parts);
});

type Fields = Record<string, string>;

const logLines = (run: string): string[] => {
    const mine = new RegExp(` run=${run}(\\s|$)`, `u`);
    return logged.filter((line) => mine.test(line));
};

/** The `event` line the launch `run` logged, as its `key=value` fields, waiting up to `timeoutMs` for it. */
const waitFor = async (run: string, event: string, timeoutMs: number): Promise<Fields> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const line = logLines(run).find((one) => one.includes(`${event} `));
        if (line !== undefined) {
            return fields(line);
        }
        if (Date.now() > deadline) {
            throw new Error(`launch ${run} never logged ${event}`);
        }
        await sleep(100);
    }
};

const fields = (line: string): Fields => Object.fromEntries([...line.matchAll(/(\w[\w-]*)=(\S+)/gu)].map((match) => [match[1] ?? ``, match[2] ?? ``]));

const median = (values: readonly number[]): number => {
    const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[middle] ?? Number.NaN) : ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2;
};

const spread = (values: readonly number[], digits = 0): string => {
    const finite = values.filter((value) => Number.isFinite(value));
    if (finite.length === 0) {
        return `–`;
    }
    const show = (value: number): string => value.toLocaleString(`en-US`, { maximumFractionDigits: digits, minimumFractionDigits: digits });
    return `${show(median(finite))} (${show(Math.min(...finite))}–${show(Math.max(...finite))})`;
};

const temperature = (): number => Number(shell(`dumpsys battery`).match(/temperature: (\d+)/u)?.[1] ?? Number.NaN) / 10;

interface Launch {
    /** The id its log lines carry. */
    readonly run: string;
    /** The system's `TotalTime`: process start to the first frame drawn. */
    readonly totalTime: number;
}

/** Starts `activity` cold in `mode`, the screen woken first. */
let launches = 0;
const stamp = Date.now().toString(36);
const launch = (activity: string, mode: string): Launch => {
    launches += 1;
    const run = `${stamp}-${launches}`;
    shell(`input keyevent KEYCODE_WAKEUP`);
    const started = shell(`am start -S -W -n ${PACKAGE}/.${activity} --es mode ${mode} --es run ${run}`);
    return { run, totalTime: Number(started.match(/TotalTime: (\d+)/u)?.[1] ?? Number.NaN) };
};

/** Every mode once per round, the first one a step later each round. */
const rounds = async (count: number, each: (mode: string) => Promise<void>): Promise<void> => {
    for (let round = 0; round < count; round += 1) {
        for (let at = 0; at < modes.length; at += 1) {
            const mode = modes[(at + round) % modes.length] ?? ``;
            await each(mode);
            shell(`am force-stop ${PACKAGE}`);
            await sleep(1_000);
        }
    }
};

if (!shell(`pm list packages ${PACKAGE}`).includes(`package:${PACKAGE}`)) {
    throw new Error(`${PACKAGE} is not installed on ${serial}: see README.md, Commands`);
}
// Compiled ahead of time, so no mode is timed in the JIT.
if (!args.includes(`--no-compile`)) {
    shell(`cmd package compile -m speed -f ${PACKAGE}`);
}
const about = `${shell(`getprop ro.product.model`).trim()}, Android ${shell(`getprop ro.build.version.release`).trim()}`;
process.stdout.write(`${about}\n`);
const temperatures = [temperature()];

interface First {
    readonly totalTime: number;
    readonly loadMs: number;
    readonly libUs: number;
    readonly firstCallUs: number;
}
const firsts = new Map<string, First[]>(modes.map((mode) => [mode, []]));
await rounds(starts, async (mode) => {
    const { run, totalTime } = launch(`FirstActivity`, mode);
    const first = await waitFor(run, `BENCH_FIRST`, 15_000);
    firsts.get(mode)?.push({ totalTime, loadMs: Number(first[`loadMs`]), libUs: Number(first[`libUs`]), firstCallUs: Number(first[`firstCallUs`]) });
});
temperatures.push(temperature());

const calls = new Map<string, Map<string, number[]>>(modes.map((mode) => [mode, new Map()]));
await rounds(callRuns, async (mode) => {
    // A launch whose activity started twice timed two sets of calls at once: it is discarded and taken again.
    for (let attempt = 1; ; attempt += 1) {
        const { run } = launch(`CallsActivity`, mode);
        await waitFor(run, `BENCH_DONE`, 300_000);
        await sleep(500);
        const lines = logLines(run);
        const timed = lines.filter((one) => one.includes(`BENCH_CALL `)).map(fields);
        const once = lines.filter((one) => one.includes(`BENCH_FIRST `)).length === 1 && new Set(timed.map((one) => one[`op`])).size === timed.length;
        if (!once && attempt < 3) {
            process.stdout.write(`launch ${run} (${mode}) started twice; taking it again\n`);
            shell(`am force-stop ${PACKAGE}`);
            continue;
        }
        for (const { op = ``, nsPerCall = `` } of timed) {
            const byOp = calls.get(mode);
            byOp?.set(op, [...(byOp.get(op) ?? []), Number(nsPerCall)]);
        }
        return;
    }
});
temperatures.push(temperature());

const out = join(tmpdir(), `intentic-bridge-bench`);
mkdirSync(out, { recursive: true });
const file = join(out, `results-${new Date().toISOString().replace(/[:.]/gu, `-`)}.json`);
writeFileSync(
    file,
    JSON.stringify({ about, temperatures, firsts: Object.fromEntries(firsts), calls: Object.fromEntries([...calls].map(([mode, byOp]) => [mode, Object.fromEntries(byOp)])) }, null, 2),
);

const print = (line: string): void => {
    process.stdout.write(`${line}\n`);
};
print(`\n${starts} cold starts per mode, median (min–max)\n`);
print(`| mode | TotalTime ms | process start to library ready ms | load step ms | first call µs |`);
print(`| --- | --- | --- | --- | --- |`);
for (const [mode, runs] of firsts) {
    print(
        `| ${mode} | ${spread(runs.map((one) => one.totalTime))} | ${spread(runs.map((one) => one.loadMs))} | ${spread(
            runs.map((one) => one.libUs / 1_000),
            1,
        )} | ${spread(runs.map((one) => one.firstCallUs))} |`,
    );
}
print(`\nns per call, ${callRuns} launches per mode of 100,000 calls each, median (min–max)\n`);
print(`| op | ${modes.join(` | `)} |`);
print(`| --- | ${modes.map(() => `---`).join(` | `)} |`);
for (const op of OPS) {
    print(`| ${op} | ${modes.map((mode) => spread(calls.get(mode)?.get(op) ?? [])).join(` | `)} |`);
}
print(`\nbattery temperature: ${temperatures.join(` → `)} °C\nruns: ${file}`);
stream.kill();
