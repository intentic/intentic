import { spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { errnoCode } from "@intentic/base/errors";

/* ONE SLOT HELD: Node has no flock, so a bash child holds each lock, as test-memory-pool.mjs does. It opens the slot
   file, takes the lock without waiting, says so on a line, then waits on stdin. Closing stdin (a release, or this
   service dying and the pipe closing with it) ends the child, and the kernel drops its lock. A child that dies for any
   other reason loses its lock the same way, which `alive` tells the round. */

export interface SlotLock {
    readonly pid: number | undefined;
    readonly alive: () => boolean;
    // Ends the child; resolves once it has exited, so its lock is gone.
    readonly release: () => Promise<void>;
}

// The lock on one slot file, taken without waiting, or undefined when someone else holds it or it would not open.
export type TakeLock = (path: string) => Promise<SlotLock | undefined>;

const HOLD = `exec {fd}<"$1" 2>/dev/null || { echo unopenable; exit 2; }
flock -n "$fd" || { echo busy; exit 1; }
echo held
read -r _ || true
`;

// How long a released child may take to exit before it is killed: its lock must not outlive the release by much.
const RELEASE_GRACE_MS = 5_000;

export const takeLock: TakeLock = async (path) =>
    await new Promise((resolve) => {
        const child = spawn("bash", ["-c", HOLD, "intentic-ci-slot", path], { stdio: ["pipe", "pipe", "ignore"] });
        let alive = true;
        let settled = false;
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        const settle = (lock: SlotLock | undefined): void => {
            if (!settled) {
                settled = true;
                resolve(lock);
            }
        };
        const release = async (): Promise<void> => {
            if (!alive) {
                return;
            }
            child.stdin.end();
            const killer = setTimeout(() => child.kill("SIGKILL"), RELEASE_GRACE_MS);
            await exited;
            clearTimeout(killer);
        };
        child.once("error", () => {
            alive = false;
            settle(undefined);
        });
        child.once("exit", () => {
            alive = false;
            settle(undefined);
        });
        // A child that has already gone must not fail this service through its closed stdin.
        child.stdin.on("error", () => undefined);
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
            out += chunk.toString("utf8");
            if (!out.includes("\n")) {
                return;
            }
            if (out.startsWith("held")) {
                settle({ pid: child.pid, alive: () => alive, release });
                return;
            }
            child.stdin.end();
            settle(undefined);
        });
    });

// The pool's folder and a slot's file, made where missing. A file this root service makes is opened by the runner
// user's jobs for appending, so it is left writable to all, as a job-made one would be to its user.
export const ensureSlotFile = async (dir: string, path: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o755 });
    try {
        const handle = await open(path, "wx", 0o666);
        await handle.close();
        await chmod(path, 0o666);
    } catch (error) {
        if (errnoCode(error) !== "EEXIST") {
            throw error;
        }
    }
};
