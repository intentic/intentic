// Runs a check inside this process instead of a child of its own, for run.mjs's `--paths` runs: the per-edit moment
// paid a node start, a load of lib/repo.mjs and its manifest walk, and the same git listings once per check, about
// thirty-five times an edit. One process pays them once and keeps every module it loaded for the next check.
//
// A check still meets what a child would: its own argv, stdout and stderr of its own, and an exit code from
// `process.exit` or `process.exitCode`, or 1 with the error printed when it throws. `process.exit` ends the check rather
// than the process: it throws, so the rest of the check does not run, and whatever the check's leftover callbacks write
// after it is dropped, as a dead child's would be. Each check's own async work is told apart by AsyncLocalStorage,
// which follows it through awaits, timers and child-process callbacks.
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

const current = new AsyncLocalStorage();

// What `process.exit` throws inside a check, to unwind it as a dead process would stop.
class Exited extends Error {}

const real = { exit: process.exit, stdout: process.stdout.write, stderr: process.stderr.write };

// Installed once and left in place: a check's late callback may run after its turn, and must still not reach the
// process's own streams or end it.
let installed = false;
const install = () => {
    if (installed) {
        return;
    }
    installed = true;
    // A stream's write takes text or bytes, then an encoding, a callback or both.
    const capture = (stream, name) =>
        function write(chunk, encoding, callback) {
            const run = current.getStore();
            if (run === undefined) {
                return real[name].call(stream, chunk, encoding, callback);
            }
            run.write(name, ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString(`utf8`) : String(chunk));
            // The callback is the last argument given; an encoding is a string, which has no `call`.
            const done = callback ?? encoding;
            if (done?.call !== undefined) {
                process.nextTick(done);
            }
            return true;
        };
    process.stdout.write = capture(process.stdout, `stdout`);
    process.stderr.write = capture(process.stderr, `stderr`);
    process.exit = (code) => {
        const run = current.getStore();
        if (run === undefined) {
            return real.exit.call(process, code);
        }
        run.end(code ?? process.exitCode ?? 0);
        throw new Exited();
    };
    // A throw no await reaches (a callback, a rejection nobody handled) ends the check it came from, as it would end its
    // child; one from outside every check is this process's own, and ends it the way node would.
    const crashed = (error) => {
        const run = current.getStore();
        if (run === undefined) {
            real.stderr.call(process.stderr, `${inspect(error)}\n`);
            real.exit.call(process, 1);
        }
        if (!(error instanceof Exited)) {
            run.crash(error);
        }
    };
    process.on(`uncaughtException`, crashed);
    process.on(`unhandledRejection`, crashed);
    // A rejection awaited only after it went unhandled (an exit thrown inside a promise the check awaits later) would
    // otherwise print node's PromiseRejectionHandledWarning on this process's stderr. A child exited before it could.
    process.on(`rejectionHandled`, () => undefined);
};

/** Runs the check at `file` with `args` after it on its argv, and answers `{ code, stdout, stderr }` as its child would. */
export const runInProcess = async (file, args) => {
    install();
    let stdout = ``;
    let stderr = ``;
    let code;
    let ended;
    const over = new Promise((resolve) => {
        ended = resolve;
    });
    const run = {
        write: (name, text) => {
            if (code !== undefined) {
                return;
            }
            if (name === `stdout`) {
                stdout += text;
            } else {
                stderr += text;
            }
        },
        end: (exit) => {
            if (code === undefined) {
                code = Number(exit) || 0;
                ended();
            }
        },
        crash: (error) => {
            if (code === undefined) {
                stderr += `${inspect(error)}\n`;
                run.end(1);
            }
        },
    };
    const argv = process.argv;
    process.argv = [process.execPath, file, ...args];
    process.exitCode = undefined;
    try {
        await Promise.race([
            current.run(run, () => import(pathToFileURL(file).href)).then(
                () => run.end(process.exitCode ?? 0),
                (error) => (error instanceof Exited ? undefined : run.crash(error)),
            ),
            over,
        ]);
    } finally {
        process.argv = argv;
        process.exitCode = undefined;
    }
    return { code, stdout, stderr };
};
