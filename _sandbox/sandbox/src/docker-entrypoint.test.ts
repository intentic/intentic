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

/* File sync's scan caches outlive a recreate, so a swap does not re-hash every synced byte (2026-11-15). */
describe(`entrypoint Mutagen home`, () => {
    it(`points the root's .mutagen/caches at a folder on /history before sshd can start an agent`, () => {
        const link = entrypoint.indexOf(`ln -s "$mutagen_caches" /root/.mutagen/caches`);
        expect(entrypoint).toContain(`mutagen_caches="$HISTORY_ROOT/cache/mutagen/caches"`);
        expect(link).toBeGreaterThan(-1);
        expect(entrypoint.indexOf("/usr/sbin/sshd")).toBeGreaterThan(link);
    });

    // Mutagen renames its agent from $HOME into `.mutagen/agents`: a whole `.mutagen` on another volume fails that
    // rename with EXDEV, and no session can start.
    it(`moves only the caches, never the folder Mutagen installs its agent into`, () => {
        expect(entrypoint).not.toMatch(/ln -s \S+ \/root\/\.mutagen(\s|$)/);
    });

    it(`tags the folder as a cache and prunes only caches nobody has written for a month`, () => {
        expect(entrypoint).toContain(`"$mutagen_caches/CACHEDIR.TAG"`);
        expect(entrypoint).toContain(`find "$mutagen_caches" -mindepth 1 -maxdepth 1 -type f ! -name CACHEDIR.TAG -mtime +30 -delete`);
    });
});

/* An engine before 2026-11-03 put WSL's GPU libraries on the whole container's library path (bin/gpu-run says why). */
describe(`entrypoint GPU libraries`, () => {
    it(`takes them off before sshd or the daemon starts, keeping their place for gpu-run`, () => {
        const strip = entrypoint.indexOf(`grep -vxE '/usr/lib/wsl/lib/?'`);
        expect(strip).toBeGreaterThan(-1);
        expect(entrypoint).toContain(`export INTENTIC_GPU_LIBRARY_PATH="\${INTENTIC_GPU_LIBRARY_PATH:-/usr/lib/wsl/lib}"`);
        expect(entrypoint.indexOf("/usr/sbin/sshd")).toBeGreaterThan(strip);
        expect(entrypoint.indexOf("exec /opt/sandbox/netd/intentic-netd")).toBeGreaterThan(strip);
    });
});
