#!/usr/bin/env node
// Type-only import so this file has NO runtime import of its own — everything loads dynamically below,
// where a failure is catchable. The pattern (and the reason) is iq's cli.ts: a broken module graph must
// die as webq's own one-line error on stdout, not as a raw node stack an agent's `2>/dev/null` swallows
// into something indistinguishable from an empty result.
import type { StricliProcess } from "@stricli/core";

// Piping into `head` closes stdout mid-write; EPIPE is a clean stop, not a crash (grep convention).
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
        process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    }
    throw error;
});

// Errors go to STDOUT: the reader is an agent, and `webq … 2>/dev/null` is a reflex that would turn a fetch
// failure into something indistinguishable from an empty page (iq's transcript-audited lesson). The exit
// code still says 2, so a script can tell the difference.
const emit = process.stdout.write.bind(process.stdout);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean =>
    (emit as (value: string | Uint8Array, ...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stderr.write;

let cli: { run: typeof import("@stricli/core").run; app: typeof import("./app.js").app };
try {
    const [core, appModule] = await Promise.all([import("@stricli/core"), import("./app.js")]);
    cli = { run: core.run, app: appModule.app };
} catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    process.stdout.write(`webq: cannot start, ${detail}\nwebq: this is a broken install, NOT an empty page. Reinstall webq and report it.\n`);
    process.exit(2);
}

await cli.run(cli.app, process.argv.slice(2), { process: process as StricliProcess });
// 0 content, 1 none, 2 anything else — clamp stricli's own routing codes into the contract.
if (process.exitCode !== undefined && process.exitCode !== 0 && process.exitCode !== 1) {
    process.exitCode = 2;
}
