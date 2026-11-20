import type { ChildProcess } from "node:child_process";
import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { readTextIfExistsSync } from "@intentic/base/fs";
import { join } from "node:path";
import { createBackoff, pollUntil } from "@intentic/base/async";
import { signalGroup } from "../../workload/process-group.js";
import { spawnAs, type Workload } from "../../workload/workload-class.js";
import { type Ask, castControl, type CastControl, type CropRect } from "./castd-control.js";
import type { MediaKey } from "./media-token.js";

/* One castd for one display, from its first start to its stop (castd.ts keeps one per display key). Started detached in
   a process group of its own, like the display it serves, so a daemon restart leaves it running and the next daemon
   adopts it by its pid file and socket. A castd that dies on its own is started again with backoff while its display
   answers; one that never answers its health check within the start budget is killed and counts as a death. */

// How a castd frames its display. `screen`: the window is the X screen (a kiosk Chromium the daemon launched), which
// castd resizes with RandR to the driving viewer's box × pixel ratio. `crop`: a window the daemon did not launch, whose
// viewport is a rectangle of a larger screen.
export type CastFraming = { readonly kind: "screen" } | { readonly kind: "crop"; readonly rect: CropRect };

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface CastdSpec {
    // The display's key (display.ts): one castd per key.
    readonly key: string;
    // The DISPLAY value, ":99".
    readonly display: string;
    readonly framing: CastFraming;
    // The largest screen a viewer may ask for, in display pixels: the screen Xvfb was started with.
    readonly maxSize?: { readonly width: number; readonly height: number } | undefined;
    // The PulseAudio source castd sends as sound (the window's sink's monitor, cast-audio.ts), on `server`.
    readonly audio?: { readonly source: string; readonly server: string } | undefined;
    // The class the display's browser runs as, which castd shares: it is as essential to that window as its Chromium.
    readonly workload?: Workload | undefined;
}

export interface CastdDeps {
    readonly dir: string;
    readonly binary: () => string | undefined;
    readonly spawn: (workload: Workload, command: string, args: readonly string[], env: NodeJS.ProcessEnv, logPath: string) => ChildProcess;
    readonly ask: Ask;
    // Whether castd's display still answers; a castd whose display is gone is not started again.
    readonly displayUp: (display: string) => Promise<boolean>;
    // Whether `pid` is a running castd serving `session`: a pid file outlives its process, and the number is reused.
    readonly isCastd: (pid: number, session: string) => boolean;
    readonly kill: (pid: number, signal: NodeJS.Signals) => void;
    // The pid each castd was started with, kept beside its socket so a daemon that adopts it after a restart can end it.
    readonly pids: PidFiles;
    // The key castd checks tokens with and its file (media-token.ts), made on first use.
    readonly mediaKey: () => MediaKey;
    readonly log: (fields: LogFields, message: string) => void;
    readonly startMs: number;
    // Where castd writes a recording as it goes (`--record-dir`): on the workspace's disk, never the cast directory's
    // tmpfs, which is memory.
    readonly recordDir: string;
    // When the daemon last dropped every viewer (castd.ts dropCastdViewers), in ms since the epoch, 0 for never: a castd
    // started after it refuses the tokens minted before it too (`--not-before`).
    readonly droppedAt: () => number;
}

export interface PidFiles {
    readonly read: (path: string) => number | undefined;
    readonly write: (path: string, pid: number) => void;
    readonly remove: (path: string) => void;
}

export const pidFilesOnDisk: PidFiles = {
    read: (path) => {
        const pid = Number(readTextIfExistsSync(path)?.trim() ?? Number.NaN);
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    },
    write: (path, pid) => writeFileSync(path, String(pid), { mode: 0o600 }),
    remove: (path) => rmSync(path, { force: true }),
};

// castd's stderr goes to a log beside its socket, replaced each start: the only account of a window whose picture
// stopped, and a file outlives the daemon that started it, as castd does.
export const spawnDetached: CastdDeps["spawn"] = (workload, command, args, env, logPath) => {
    const log = openSync(logPath, "w", 0o600);
    try {
        const child = spawnAs(workload, command, args, { detached: true, stdio: ["ignore", "ignore", log], env });
        // Seen as the exit that follows: a binary that cannot run is a castd that never answered.
        child.on("error", () => undefined);
        child.unref();
        return child;
    } finally {
        closeSync(log);
    }
};

// A process that is gone has no /proc entry, which reads as no argv.
export const isCastdProcess = (pid: number, session: string): boolean => {
    const argv = (readTextIfExistsSync(`/proc/${pid}/cmdline`) ?? "").split("\0");
    return argv.some((arg) => arg.endsWith("castd")) && argv.includes(session);
};

// castd leads a process group of its own (spawned detached, by this daemon or an earlier one), which the signal ends
// whole; one already gone is the outcome asked for.
export const killQuietly = (pid: number, signal: NodeJS.Signals): void => {
    signalGroup(pid, signal);
};

// What castd is started with besides its spec: where it writes recordings, and the last drop it must still honour.
export interface CastdLaunch {
    readonly recordDir?: string | undefined;
    readonly notBefore?: number | undefined;
}

// castd's argv for a spec; the sound's server travels in its environment (PULSE_SERVER).
export const castdArgs = (spec: CastdSpec, session: string, socket: string, keyFile: string, launch: CastdLaunch = {}): string[] => {
    const args = ["--session", session, "--key-file", keyFile, "--display", spec.display, "--socket", socket];
    if (launch.recordDir !== undefined) {
        args.push("--record-dir", launch.recordDir);
    }
    if (launch.notBefore !== undefined && launch.notBefore > 0) {
        args.push("--not-before", String(Math.floor(launch.notBefore)));
    }
    if (spec.framing.kind === "crop") {
        const { x, y, width, height } = spec.framing.rect;
        args.push("--crop", `${x},${y},${width},${height}`);
    }
    if (spec.maxSize !== undefined) {
        args.push("--max-size", `${spec.maxSize.width}x${spec.maxSize.height}`);
    }
    if (spec.audio !== undefined) {
        args.push("--audio-source", spec.audio.source);
    }
    return args;
};

const sameRect = (left: CropRect, right: CropRect): boolean => left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;

export class CastdProcess {
    readonly socket: string;
    readonly control: CastControl;
    private framingNow: CastFraming;
    private child: ChildProcess | undefined;
    private pid: number | undefined;
    private stopped = false;
    private generation = 0;
    private readyNow: Promise<boolean> = Promise.resolve(false);
    // One move of the crop at a time, behind the first start: two at once would each end the castd and launch their own,
    // the first launch left running beside the second with nothing tracking it.
    private moving: Promise<void> = Promise.resolve();
    private restartTimer: NodeJS.Timeout | undefined;
    private readonly listeners = new Set<(generation: number) => void>();
    // A castd that died within a minute of starting climbs the ladder; one that ran longer starts again at the floor.
    private readonly backoff = createBackoff({ floorMs: 500, capMs: 30_000, stableMs: 60_000 });

    constructor(
        private readonly spec: CastdSpec,
        readonly session: string,
        private readonly deps: CastdDeps,
    ) {
        this.socket = join(deps.dir, `${session}.sock`);
        this.control = castControl(this.socket, deps.ask);
        this.framingNow = spec.framing;
        this.readyNow = this.adoptOrLaunch();
        // allow(silent-catch): a first start that threw is `ready()`'s to report; a move behind it still runs.
        this.moving = this.readyNow.then(
            () => undefined,
            () => undefined,
        );
    }

    get key(): string {
        return this.spec.key;
    }

    // The DISPLAY it serves: a key whose display came back on another number needs a castd of its own (castd.ts).
    get display(): string {
        return this.spec.display;
    }

    framing(): CastFraming {
        return this.framingNow;
    }

    // Resolves once castd answers its health check (true), or did not within the start budget (false).
    ready(): Promise<boolean> {
        return this.readyNow;
    }

    // Calls back each time castd has (re)started and answers: a viewer's media socket died with the last one, and the
    // window may need fitting again to the screen RandR put back.
    onStarted(listener: (generation: number) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // Moves a cropped castd's rectangle; started again there when it cannot move it live, at the cost of every
    // viewer's socket. A castd serving its whole screen is left as it is: a crop is never made of it here.
    moveCrop(rect: CropRect): Promise<void> {
        const moved = this.moving.then(() => this.applyCrop(rect));
        // allow(silent-catch): a failed move is its own caller's to hear; the next one still runs.
        this.moving = moved.catch(() => undefined);
        return moved;
    }

    private async applyCrop(rect: CropRect): Promise<void> {
        if (this.stopped || this.framingNow.kind !== "crop" || sameRect(this.framingNow.rect, rect)) {
            return;
        }
        this.framingNow = { kind: "crop", rect };
        if (await this.control.crop(rect)) {
            return;
        }
        await this.end();
        this.launch();
        await this.readyNow;
    }

    stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        clearTimeout(this.restartTimer);
        this.listeners.clear();
        const running = this.pid;
        void this.end();
        this.deps.pids.remove(this.pidPath());
        this.deps.log({ session: this.session, pid: running }, "castd: stopped");
    }

    private pidPath(): string {
        return join(this.deps.dir, `${this.session}.pid`);
    }

    private announce(): void {
        this.generation += 1;
        for (const listener of this.listeners) {
            listener(this.generation);
        }
    }

    // Ends the running castd: SIGTERM (castd removes its socket), SIGKILL if it is still there two seconds on.
    private async end(): Promise<void> {
        const running = this.pid;
        this.child = undefined;
        this.pid = undefined;
        if (running === undefined) {
            return;
        }
        this.deps.kill(running, "SIGTERM");
        if (!(await pollUntil(() => !this.deps.isCastd(running, this.session), { intervalMs: 50, timeoutMs: 2_000 }))) {
            this.deps.kill(running, "SIGKILL");
        }
    }

    // A castd an earlier daemon life started for this display is adopted when it answers framed as asked; otherwise
    // whatever holds the socket is ended and a fresh one started.
    private async adoptOrLaunch(): Promise<boolean> {
        const recorded = this.deps.pids.read(this.pidPath());
        const live = recorded !== undefined && this.deps.isCastd(recorded, this.session) ? recorded : undefined;
        if (live !== undefined && (await this.control.healthy())) {
            const geometry = await this.control.geometry();
            // Stopped while it was being asked (its display went): ended below, never adopted past the stop.
            if (!this.stopped && geometry !== undefined && (geometry.crop !== null) === (this.framingNow.kind === "crop")) {
                this.pid = live;
                this.deps.log({ session: this.session, pid: live }, "castd: adopted from an earlier daemon");
                this.announce();
                this.watchAdopted(live);
                return true;
            }
        }
        if (live !== undefined) {
            this.pid = live;
            await this.end();
        }
        this.launch();
        return this.readyNow;
    }

    // An adopted castd is no child of this process: its death is read off /proc instead of an exit event.
    private watchAdopted(adopted: number): void {
        const timer = setInterval(() => {
            if (this.stopped || this.pid !== adopted) {
                clearInterval(timer);
            } else if (!this.deps.isCastd(adopted, this.session)) {
                clearInterval(timer);
                this.pid = undefined;
                this.deps.log({ session: this.session, pid: adopted }, "castd: the adopted one exited; starting a new one");
                this.restartLater(0);
            }
        }, 2_000);
        timer.unref();
    }

    private restartLater(uptimeMs: number): void {
        if (this.stopped || this.restartTimer !== undefined) {
            return;
        }
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            void this.deps.displayUp(this.spec.display).then((up) => {
                if (this.stopped) {
                    return;
                }
                if (up) {
                    this.launch();
                } else {
                    this.deps.log({ session: this.session, display: this.spec.display }, "castd: its display is gone; not starting it again");
                }
            });
        }, this.backoff.next(uptimeMs));
        this.restartTimer.unref();
    }

    private environment(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: this.spec.display };
        if (this.spec.audio !== undefined) {
            env["PULSE_SERVER"] = this.spec.audio.server;
        }
        return env;
    }

    // Spawns castd; `ready` settles once it answers or the start budget is spent, which kills it and counts as a death.
    private launch(): void {
        const binary = this.deps.binary();
        if (binary === undefined || this.stopped) {
            this.readyNow = Promise.resolve(false);
            return;
        }
        const args = castdArgs({ ...this.spec, framing: this.framingNow }, this.session, this.socket, this.deps.mediaKey().path, {
            recordDir: this.deps.recordDir,
            notBefore: this.deps.droppedAt(),
        });
        const startedAt = Date.now();
        const started = this.deps.spawn(this.spec.workload ?? { class: "service" }, binary, args, this.environment(), join(this.deps.dir, `${this.session}.log`));
        this.child = started;
        this.pid = started.pid;
        if (started.pid !== undefined) {
            this.deps.pids.write(this.pidPath(), started.pid);
        }
        this.deps.log({ session: this.session, display: this.spec.display, pid: started.pid, framing: this.framingNow.kind }, "castd: started");
        started.once("exit", (code, signal) => {
            if (this.child !== started) {
                return;
            }
            this.child = undefined;
            this.pid = undefined;
            if (!this.stopped) {
                this.deps.log({ session: this.session, code, signal, uptimeMs: Date.now() - startedAt }, "castd: exited unasked; starting it again");
                this.restartLater(Date.now() - startedAt);
            }
        });
        this.readyNow = pollUntil(() => this.control.healthy(), { intervalMs: 50, timeoutMs: this.deps.startMs }).then((up) => {
            if (this.child !== started || this.stopped) {
                return up;
            }
            if (up) {
                this.backoff.reset();
                this.announce();
            } else {
                this.deps.log({ session: this.session, display: this.spec.display }, "castd: did not answer in time");
                started.kill("SIGKILL");
            }
            return up;
        });
    }
}
