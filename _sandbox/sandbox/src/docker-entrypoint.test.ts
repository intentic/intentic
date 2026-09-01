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

/* Reachability used to be an entrypoint-managed zrok agent whose bind/reclaim loop this file pinned. The daemon
 * dials its own ingress tunnel now (SANDBOX_GRANT/INGRESS_URL), so the entrypoint must carry none of that. */
describe(`entrypoint reachability`, () => {
    it(`carries no tunnel agent machinery — the daemon dials the ingress itself`, () => {
        expect(entrypoint).not.toMatch(/zrok2|ZROK_|share public|zrok\.log/);
    });
});
