// The phone, reached through adb: shell commands, the log since a moment, the layers SurfaceFlinger composes, a
// Perfetto trace. Every call names the device's serial, so the bench never acts on a phone it was not pointed at.

import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import type { Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Latency, parseLatency } from "./frames.ts";

// allow(primitive-tiers): a hand-run script plain node loads from the tree, and @intentic/base's runBounded only loads
// built or under bun; adb is the one child, and every call has a deadline.
const run = promisify(execFile);
// A phone that drops off the network fails the run instead of hanging it.
const CALL_TIMEOUT_MS = 30_000;

// Separates the layers' answers in one `adb shell` that asks SurfaceFlinger about each of them.
const MARK = `@@spike-layer@@`;

export class Device {
    readonly serial: string;
    private readonly adbPath: string;

    constructor(serial: string, adbPath = process.env[`ADB`] ?? `adb`) {
        this.serial = serial;
        this.adbPath = adbPath;
    }

    adb(args: readonly string[], input?: string): string {
        return execFileSync(this.adbPath, [`-s`, this.serial, ...args], { encoding: `utf8`, maxBuffer: 64 * 1024 * 1024, input });
    }

    shell(command: string): string {
        return this.adb([`shell`, command]);
    }

    /** `shell` without blocking: what runs while a scenario is measured, so polls and log reads never wait on each other. */
    async shellAsync(command: string): Promise<string> {
        const { stdout } = await run(this.adbPath, [`-s`, this.serial, `shell`, command], {
            encoding: `utf8`,
            maxBuffer: 64 * 1024 * 1024,
            timeout: CALL_TIMEOUT_MS,
        });
        return stdout;
    }

    /** The device's wall clock, in seconds: what `logcat -v epoch` stamps lines with. */
    now(): number {
        return Number(this.shell(`date +%s.%N`).trim());
    }

    /**
     * `Spike` and activity-start log lines, as one `adb logcat` streams them for the whole run. Dumping the log again
     * every few hundred milliseconds to wait on a line had the phone's log daemon and adbd work beside the arm being
     * measured, and blocked the polls of SurfaceFlinger long enough to lose frames.
     */
    private log: { readonly child: ChildProcess; readonly lines: string[] } | undefined;

    /** Starts streaming the log; lines logged before this are not seen. Called once, before the first launch. */
    followLog(): void {
        if (this.log !== undefined) {
            return;
        }
        const child = spawn(this.adbPath, [`-s`, this.serial, `logcat`, `-v`, `epoch`, `-T`, `1`, `-s`, `Spike:I`, `IntenticCore:I`, `ActivityTaskManager:I`], {
            stdio: [`ignore`, `pipe`, `ignore`],
        });
        const lines: string[] = [];
        let partial = ``;
        child.stdout?.setEncoding(`utf8`);
        child.stdout?.on(`data`, (chunk: string) => {
            const parts = `${partial}${chunk}`.split(/\r?\n/u);
            partial = parts.pop() ?? ``;
            lines.push(...parts);
        });
        // The stream never ends by itself: it must not keep the bench alive once its work is done.
        child.unref();
        // SAFETY: a stream spawn opened as "pipe" is a net.Socket, which has unref.
        (child.stdout as Socket | null)?.unref();
        this.log = { child, lines };
    }

    /** Stops the log stream. */
    close(): void {
        this.log?.child.kill();
        this.log = undefined;
    }

    /** `Spike` and activity-start log lines stamped at or after `since` (device seconds). */
    logSince(since: number): string[] {
        this.followLog();
        return (this.log?.lines ?? []).filter((line) => Number(line.trim().split(/\s+/u)[0]) >= since);
    }

    /** The first log line since `since` that matches, or undefined once `timeoutMs` has passed. */
    async waitFor(pattern: RegExp, since: number, timeoutMs: number): Promise<RegExpMatchArray | undefined> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            for (const line of this.logSince(since)) {
                const match = line.match(pattern);
                if (match !== null) {
                    return match;
                }
            }
            await sleep(250);
        }
        return undefined;
    }

    /**
     * The layers that may show an activity's content: those named after it, less the system's wrappers around them.
     * An arm can draw on more than one (arm C: the transcript's SurfaceView under the window that holds the composer).
     */
    layersOf(component: string): string[] {
        const [pkg, activity] = component.split(`/`);
        const className = activity?.startsWith(`.`) ? `${pkg}${activity}` : activity;
        if (className === undefined) {
            return [];
        }
        // A layer's name may or may not carry the hash its view prefixes it with: both spellings are tried.
        const names = new Set(
            this.shell(`dumpsys SurfaceFlinger --list`)
                .split(/\r?\n/u)
                .map((line) => (line.trim().match(/^RequestedLayerState\{(.*)\}$/u)?.[1] ?? line.trim()).replace(/ (parentId|relativeParentId|z)=.*$/u, ``))
                .flatMap((name) => [name, name.replace(/^[0-9a-f]{6,8} /u, ``)])
                .filter((name) => name.includes(className) && !/ActivityRecord|InputSink|Splash|Surface\(name=|leash|Background|Bounds for/u.test(name)),
        );
        return [...names];
    }

    /** Each layer's refresh period and last 128 presents, asked in one round trip. */
    async latencies(layers: readonly string[]): Promise<Latency[]> {
        const quote = (text: string): string => `'${text.replaceAll(`'`, `'\\''`)}'`;
        const output = await this.shellAsync(layers.map((layer) => `echo ${MARK}; dumpsys SurfaceFlinger --latency ${quote(layer)}`).join(`; `));
        return output
            .split(new RegExp(`^${MARK}\\r?\\n`, `mu`))
            .slice(1)
            .map(parseLatency);
    }

    /**
     * Polls each layer's presents every half second until `stop` resolves. SurfaceFlinger keeps a layer's last 128,
     * about two seconds at 60Hz, so a poll that comes later than that loses frames: `lostFrames` (frames.ts) checks.
     */
    async pollLatency(layers: readonly string[], stop: Promise<unknown>): Promise<Map<string, Latency[]>> {
        const polls = new Map(layers.map((layer): [string, Latency[]] => [layer, []]));
        const pollAll = async (): Promise<void> => {
            const answers = await this.latencies(layers);
            layers.forEach((layer, index) => {
                const answer = answers[index];
                if (answer !== undefined) {
                    polls.get(layer)?.push(answer);
                }
            });
        };
        const state = { stopped: false };
        void stop.then(() => {
            state.stopped = true;
        });
        while (!state.stopped) {
            await pollAll();
            await sleep(500);
        }
        await pollAll();
        return polls;
    }

    /**
     * The battery's current every half second until `stop` resolves, mA drawn; nothing while the phone is plugged in.
     * Phones disagree on the sysfs unit and sign: this one (a Galaxy S10) reports mA, positive while charging, and
     * drawing reads negative, so the magnitude is taken.
     */
    async pollCurrent(stop: Promise<unknown>): Promise<number[]> {
        const powered = /(AC|USB|Wireless) powered: true/u.test(await this.shellAsync(`dumpsys battery`));
        if (powered) {
            return [];
        }
        const readings: number[] = [];
        const state = { stopped: false };
        void stop.then(() => {
            state.stopped = true;
        });
        while (!state.stopped) {
            const now = Number((await this.shellAsync(`cat /sys/class/power_supply/battery/current_now`)).trim());
            if (Number.isFinite(now)) {
                readings.push(Math.abs(now));
            }
            await sleep(500);
        }
        return readings;
    }

    /** The package's total PSS in MB, its sandboxed renderer's added for a WebView (`sandboxed`). */
    pssMb(pkg: string, sandboxed = false): number {
        const total = (name: string): number => Number(this.shell(`dumpsys meminfo ${name}`).match(/TOTAL PSS:\s+(\d+)/u)?.[1] ?? 0) / 1024;
        // The WebView's renderer is a process of its own, named after the WebView package rather than the app.
        const renderer = sandboxed
            ? this.shell(`ps -A -o PID,NAME`)
                  .split(/\r?\n/u)
                  .filter((line) => line.includes(`sandboxed_process`))
                  .map((line) => total(line.trim().split(/\s+/u)[0] ?? ``))
                  .reduce((sum, mb) => sum + mb, 0)
            : 0;
        return total(pkg) + renderer;
    }

    /** Records a Perfetto trace of `config` (text proto) for its own duration and pulls it into `outDir`. */
    async trace(config: string, outDir: string, name: string): Promise<string> {
        const remote = `/data/misc/perfetto-traces/${name}.pftrace`;
        await new Promise<void>((resolve, reject) => {
            const child = spawn(this.adbPath, [`-s`, this.serial, `shell`, `perfetto`, `--txt`, `-c`, `-`, `-o`, remote], { stdio: [`pipe`, `ignore`, `pipe`] });
            let errors = ``;
            child.stderr.on(`data`, (chunk: Buffer) => void (errors += chunk.toString()));
            child.once(`exit`, (code) => (code === 0 ? resolve() : reject(new Error(`perfetto exited ${code}: ${errors.slice(-2000)}`))));
            child.stdin.end(config);
        });
        const local = join(outDir, `${name}.pftrace`);
        this.adb([`pull`, remote, local]);
        this.shell(`rm -f ${remote}`);
        return local;
    }
}
