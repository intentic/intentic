import { spawn, spawnSync } from "node:child_process";

// V8 is deterministic only with every background thread folded onto the main one and a GC schedule that does not read
// the machine: `--predictable` does the first, the heap flags stop the old/new space limits being sized from host RAM.
export const NODE_FLAGS = [
    "--predictable",
    "--predictable-gc-schedule",
    "--random-seed=1",
    "--max-old-space-size=2048",
    "--max-semi-space-size=16",
    "--expose-gc",
] as const;

// No cache simulation: `I refs` is all this reads, and the simulator is most of cachegrind's own cost.
const VALGRIND_FLAGS = ["--tool=cachegrind", "--cache-sim=no", "--cachegrind-out-file=/dev/null"] as const;

/** `valgrind-3.24.0`, or undefined when Valgrind is not on PATH. */
export const valgrindVersion = (): string | undefined => {
    const probe = spawnSync("valgrind", ["--version"], { encoding: "utf8" });
    return probe.status === 0 ? probe.stdout.trim() : undefined;
};

/** Reads cachegrind's `==pid== I refs: 1,234` summary line; undefined when the run produced none. */
export const parseInstructions = (stderr: string): number | undefined => {
    const match = /^==\d+== I\s+refs:\s+([\d,]+)\s*$/mu.exec(stderr);
    return match?.[1] === undefined ? undefined : Number(match[1].replaceAll(",", ""));
};

/** Guest instructions executed by `node <NODE_FLAGS> <args>` from start to exit, under a fixed environment. */
export const countInstructions = (script: string, args: readonly string[], cwd: string): Promise<number> =>
    new Promise((resolve, reject) => {
        const child = spawn("valgrind", [...VALGRIND_FLAGS, process.execPath, ...NODE_FLAGS, script, ...args], {
            cwd,
            // The child's environment is part of what it executes (ICU reads LANG, `process.env` is built from it).
            env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" },
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
            const instructions = parseInstructions(stderr);
            if (code !== 0 || instructions === undefined) {
                reject(new Error(`node ${[script, ...args].join(" ")} under valgrind exited ${code}\n${stderr.slice(-2000)}`));
                return;
            }
            resolve(instructions);
        });
    });
