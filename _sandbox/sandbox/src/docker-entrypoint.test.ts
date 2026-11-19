import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALLOCATOR_ENV, COMPILE_CACHE_ENV, DAEMON_MALLOC_CONF } from "./bootstrap/daemon-env.js";

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

    // shinobi-society, 2026-11-15..17: the project's soft.sh pinned software rendering around 316 commands by hand.
    it(`exports gpu-run's software-rendering pins for the whole container before sshd or the daemon starts`, () => {
        const pins = entrypoint.indexOf(`eval "$(gpu-run --software-env)"`);
        expect(pins).toBeGreaterThan(-1);
        expect(entrypoint.indexOf("/usr/sbin/sshd")).toBeGreaterThan(pins);
        expect(entrypoint.indexOf("exec /opt/sandbox/netd/intentic-netd")).toBeGreaterThan(pins);
    });
});

/* 2026-11-17, the shinobi-society audit: Node 24's young generation reached 128 MiB in the daemon and in each of its
   worker threads; the entrypoint holds it to two 16 MiB halves (docker-entrypoint.integration.test.ts measures it). */
describe(`entrypoint young generation`, () => {
    it(`hands the daemon a semi-space ceiling of 16 MiB on its own command line, not in NODE_OPTIONS its children read`, () => {
        const exec = entrypoint.slice(entrypoint.indexOf("exec /opt/sandbox/netd/intentic-netd"));
        expect(entrypoint).toMatch(/^semi_space_mb=16$/mu);
        expect(exec.split("\n")[0]).toContain(`node --max-old-space-size="$heap_mb" --max-semi-space-size="$semi_space_mb" `);
        expect(entrypoint).not.toMatch(/NODE_OPTIONS=.*semi-space/u);
    });
});

/* 2026-11-18: glibc kept 856 MB freed inside a daemon whose live native memory was 84 MB; jemalloc with a background
   purging thread settles the same work at 138 MB against glibc's 243 (docker-entrypoint.sh has the measurements). */
describe(`entrypoint allocator`, () => {
    const exec = entrypoint.indexOf("exec /opt/sandbox/netd/intentic-netd");

    it(`preloads jemalloc for netd and the daemon under the names the daemon takes back off its children`, () => {
        const preload = entrypoint.indexOf(`export LD_PRELOAD="$daemon_allocator"`);
        expect(preload).toBeGreaterThan(-1);
        expect(entrypoint).toContain(`export MALLOC_CONF="${DAEMON_MALLOC_CONF}"`);
        expect(entrypoint).toContain(`export ${ALLOCATOR_ENV}="$daemon_allocator"`);
        expect(exec).toBeGreaterThan(preload);
        // After sshd: a shell over ssh never starts on the daemon's allocator.
        expect(preload).toBeGreaterThan(entrypoint.indexOf("/usr/sbin/sshd"));
    });

    it(`steps aside for SANDBOX_MALLOC=glibc and for an LD_PRELOAD or MALLOC_CONF already set`, () => {
        expect(entrypoint).toContain(`[ "\${SANDBOX_MALLOC:-jemalloc}" = jemalloc ] && [ -z "\${LD_PRELOAD:-}" ] && [ -z "\${MALLOC_CONF:-}" ]`);
    });
});
