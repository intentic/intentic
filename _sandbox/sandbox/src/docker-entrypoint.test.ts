import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entrypoint = readFileSync(fileURLToPath(new URL("../docker-entrypoint.sh", import.meta.url)), "utf8");

/* Fly starts the image in its declared WORKDIR (/work), while VM mode replaces /work with a link onto the
 * persistent volume. Removing the process's current directory makes Node fail before the daemon can boot:
 * `process.cwd()` answers ENOENT / uv_cwd. Pin the ordering that makes the replacement safe. */
describe(`hosted VM entrypoint`, () => {
    it(`leaves /work before replacing it and re-enters the persistent target afterwards`, () => {
        const leave = entrypoint.indexOf("    cd /\n");
        const remove = entrypoint.indexOf("rm -rf /work");
        const link = entrypoint.indexOf("ln -s /data/work /work");
        const enter = entrypoint.indexOf("    cd /work\n");

        expect(leave).toBeGreaterThan(-1);
        expect(remove).toBeGreaterThan(leave);
        expect(link).toBeGreaterThan(remove);
        expect(enter).toBeGreaterThan(link);
    });
});

/* WHAT THIS SANDBOX IS REACHABLE AT is decided by one bind, and its retry has to know whether the name was
 * taken. zrok.log is the wrong place to ask: the agent's restart loop appends to the same file every two
 * seconds, so a window of it holds other boots' and other processes' lines. Reading it either misses this
 * attempt's 409 (the name is never reclaimed, and the sandbox 502s until somebody notices) or finds the
 * PREVIOUS attempt's (and deletes the share the agent has since restored, unbinding the address by hand).
 * Both were live failures. Pin the property that prevents them: the verdict comes from the command. */
describe(`zrok share bind`, () => {
    it(`decides on the bind's own output rather than on the shared log`, () => {
        expect(entrypoint).toContain(`bind_out="$(zrok2 share public`);
        expect(entrypoint).toMatch(/case "\$bind_out" in\n\s*\*"already in use"\*\)/);
    });

    it(`never reads zrok.log to detect the name conflict`, () => {
        // The log is written, never consulted: no line may both read the log and look for the 409.
        const consultsLog = entrypoint
            .split(`\n`)
            .filter((line) => /already in use/.test(line))
            .filter((line) => /tail|grep|cat|zrok\.log/.test(line));
        expect(consultsLog).toEqual([]);
    });
});
