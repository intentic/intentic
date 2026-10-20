import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMPILE_CACHE_ENV } from "./bootstrap/daemon-env.js";

const entrypoint = readFileSync(fileURLToPath(new URL("../docker-entrypoint.sh", import.meta.url)), "utf8");

/* Fly starts the image in its declared WORKDIR (/work), while VM mode replaces /work with a link onto the persistent volume. */
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

/* Reachability used to be an entrypoint-managed zrok agent whose bind/reclaim loop this file pinned. */
describe(`entrypoint reachability`, () => {
    it(`carries no tunnel agent machinery — the daemon dials the ingress itself`, () => {
        expect(entrypoint).not.toMatch(/zrok2|ZROK_|share public|zrok\.log/);
    });
});

/* The daemon's compiled code is kept on /history for its next start, a wake from sleep included (2026-10-19). */
describe(`entrypoint compile cache`, () => {
    it(`hands the daemon a folder on /history under the variable the daemon takes back off its children`, () => {
        const exported = entrypoint.indexOf(`export ${COMPILE_CACHE_ENV}="$node_compile_cache"`);
        expect(entrypoint).toContain(`node_compile_cache="$HISTORY_ROOT/cache/node-compile"`);
        expect(exported).toBeGreaterThan(-1);
        expect(entrypoint.indexOf("exec /opt/sandbox/netd/intentic-netd")).toBeGreaterThan(exported);
    });

    it(`tags the folder as a cache, so a backup leaves it out`, () => {
        expect(entrypoint).toContain(`Signature: 8a477f597d28d172789f06886806bc55`);
        expect(entrypoint).toContain(`"$node_compile_cache/CACHEDIR.TAG"`);
    });

    it(`prunes only whole Node-version folders nobody has written to for a month, inside its own folder`, () => {
        expect(entrypoint).toContain(`find "$node_compile_cache" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +`);
    });
});
