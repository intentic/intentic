import { stat } from "node:fs/promises";

/* (2026-11-22) The I/O thread pool, capped at 4 on Windows. The compiled agent's runtime (Bun) does file and DNS work on
   Windows in libuv's thread pool, which it sizes by the CPU count rather than libuv's own 4: on rog (16 CPUs) the first
   burst of concurrent file work grew it by 24 threads and none of them ever left. Each thread costs the agent about
   2.5 MB of stack and several MB of its allocator's heap, committed up front and almost never touched, so the agent
   held 520 MB of commit charge against under 100 MB in RAM, 120 MB of it in stacks. Measured on rog with a probe doing
   the agent's kinds of work (a worker, child processes, concurrent fs, DNS, fetch, WebSockets): 44 threads and 374 MB
   committed uncapped, 26 threads and 206 MB with this module loaded first; RAM no higher. Four is what libuv and
   Node use, so a lookup that hangs holds file work back no more than it does in any Node program.

   libuv reads the variable once, when the pool first starts, so it has to be in the environment before anything
   touches the pool. This module is the first `cli.ts` imports: it sets the variable only where nobody chose a size,
   starts the pool with one stat, and takes the variable away again, so no program this agent starts (a person's
   command above all) inherits a setting that was never theirs. Linux and macOS are left alone: there the runtime does
   not use libuv, and the probe saw the same threads and memory either way. */

export const IO_POOL_ENV = "UV_THREADPOOL_SIZE";
export const IO_POOL_THREADS = "4";

// Undefined when there was nothing to do (not Windows, or a size someone set stays theirs); otherwise settles once the
// pool has started and the variable is gone again.
export const capIoPool = (
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    start: () => Promise<void> = async () => {
        await stat(process.execPath);
    },
): Promise<void> | undefined => {
    if (platform !== "win32" || env[IO_POOL_ENV] !== undefined) {
        return undefined;
    }
    env[IO_POOL_ENV] = IO_POOL_THREADS;
    return (
        start()
            // allow(silent-catch): the stat only starts the pool; whether the file answered changes nothing
            .catch(() => undefined)
            .then(() => {
                delete env[IO_POOL_ENV];
            })
    );
};

// Started as this module is evaluated, which `cli.ts` makes the first; `cli.ts` waits for it before running a command.
export const ioPoolCapped: Promise<void> | undefined = capIoPool();
