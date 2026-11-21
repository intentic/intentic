import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errnoCode, errorMessage } from "@intentic/base/errors";
import { binDir } from "../../config.js";
import { archToken, download, exe, osToken, renameIfPresent } from "../../release.js";
import { allowNote, deniedByThePc } from "../../release/security-hint.js";
import { runProcess } from "../exec.js";
import { AGENT_BUNDLE, daemonEventLog, MUTAGEN_CALL_TIMEOUT_MS } from "../mutagen.js";

// Which Mutagen binary this agent runs, and getting it: the pinned copy in this agent's own bin with its agent bundle
// beside it, downloaded and unpacked when either is absent or another version, with PATH's copy as the fallback.

// The pinned Mutagen version this agent downloads and runs.
const MUTAGEN_VERSION = "0.18.1";

// The installed version, or undefined if missing/broken. Matters most on Windows, where a resident daemon's
// binary can be neither unlinked nor overwritten, so checking first avoids re-extracting over it.
const installedVersion = async (binary: string, versionArgs: string[]): Promise<string | undefined> => {
    const result = await runProcess(binary, versionArgs, { timeoutMs: MUTAGEN_CALL_TIMEOUT_MS });
    if (result.status !== 0) {
        return undefined;
    }
    return /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
};

// Extract a gzipped tarball into `into` using the system `tar` (bsdtar on macOS/Windows 10+).
// Not blocking, since GNU tar runs gzip as a child of its own and a stuck one would hold the agent's event loop; the
// deadline ends both. tar's own reason, which it printed to the terminal while this call inherited it, is in the error.
const extractTarball = async (tarball: string, into: string): Promise<void> => {
    const extract = await runProcess("tar", ["-xzf", tarball, "-C", into], { timeoutMs: 2 * 60_000 });
    if (extract.status !== 0) {
        const said = extract.stderr.trim();
        throw new Error(
            `failed to extract ${tarball}: ${said === "" ? "no `tar` on PATH, or a file it must replace is in use" : said.split("\n").join(" / ")}`,
        );
    }
};

// A PATH lookup is a local read; past this, the shell or `where.exe` is stuck, and the answer is "not found".
const PATH_LOOKUP_TIMEOUT_MS = 10_000;

// Where PATH's copy of a command is at this moment. A bare name is resolved again every time it is run, against a
// PATH this agent does not control, which is how an autostart entry keeps starting a binary from a retired install.
export const resolveOnPath = (command: string): string | undefined => {
    const whereExe = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "where.exe");
    const found =
        process.platform === "win32"
            ? spawnSync(whereExe, [command], { encoding: "utf8", windowsHide: true, timeout: PATH_LOOKUP_TIMEOUT_MS })
            : // `command -v` is a shell builtin: the shell starts nothing that could outlive its timeout.
              spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8", timeout: PATH_LOOKUP_TIMEOUT_MS });
    // `where` lists every match, best first; `command -v` prints the single one it would run.
    const first = found.status === 0 ? found.stdout.split("\n")[0]?.trim() : undefined;
    return first === undefined || first === "" || !existsSync(first) ? undefined : first;
};


// The copy this agent downloads and runs.
export const ownMutagenPath = (): string => join(binDir, `mutagen${exe}`);

// The other half of a Mutagen install (mutagen.ts AGENT_BUNDLE): the agents it copies into each sandbox it syncs with,
// one per platform, in one archive Mutagen looks for beside its own executable (or in ../libexec) every time it installs one.
const agentBundlePath = (mutagen: string = ownMutagenPath()): string => join(dirname(mutagen), AGENT_BUNDLE);

/* A MUTAGEN WITHOUT ITS AGENT BUNDLE IS NOT INSTALLED (2026-11-20, intentic#49). On a Windows PC with Bitdefender the bin
   folder held mutagen.exe at the pinned version and no mutagen-agents.tar.gz, from the first connect on: every sync and
   forward failed with "unable to locate agent bundle", and nothing ever fetched it again, since the only test of an
   install was `mutagen version`. Both halves are the install now, and what is missing is what is fetched: the whole
   release when the executable is absent or another version, only the bundle when the executable is right, which needs
   no daemon stopped and nothing set aside. */
export type MutagenNeed = "nothing" | "bundle" | "all";

/** What a Mutagen install at `version`, with or without its bundle beside it, lacks. Pure. */
export const mutagenNeed = (version: string | undefined, bundlePresent: boolean): MutagenNeed => {
    if (version !== MUTAGEN_VERSION) {
        return "all";
    }
    return bundlePresent ? "nothing" : "bundle";
};

/** A bundle that was in place and was gone again a moment later: something on the PC removed it. */
export class AgentBundleRemovedError extends Error {}

// The effects an install has beyond moving files inside its folder, behind one seam, so the staging is testable on a
// temporary folder without a network, a `tar` or a daemon.
export interface MutagenInstallIo {
    readonly fetch: (tarball: string) => Promise<void>;
    readonly extract: (tarball: string, into: string) => Promise<void>;
    // Stops the daemon of the copy about to be replaced, which on Windows is what holds its file open. Best-effort.
    readonly stopDaemon: (mutagen: string) => Promise<void>;
}

const realInstallIo: MutagenInstallIo = {
    fetch: async (tarball) =>
        await download(
            `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_${osToken()}_${archToken()}_v${MUTAGEN_VERSION}.tar.gz`,
            tarball,
        ),
    extract: extractTarball,
    stopDaemon: async (mutagen) => void (await runProcess(mutagen, ["daemon", "stop"], { timeoutMs: MUTAGEN_CALL_TIMEOUT_MS })),
};

// What an install leaves in the folder while it runs, named for the process and the moment so two installs never share
// a file. (2026-11-20, intentic#49) Every install used to download to one `mutagen.tar.gz` and unpack straight into bin:
// `setup` and the resident agent (which resolves Mutagen for every report it builds) could both be fetching at once,
// into the same file, and a tarball two writers had interleaved unpacks its first member and fails on the next, which
// leaves exactly a mutagen.exe with no bundle beside it.
const INSTALL_LEFTOVER = /^(?:\.mutagen-staging-\d+-\d+|mutagen-\d+-\d+\.tar\.gz)$/;

// A staging folder or tarball older than this is a crashed install's: no install runs anywhere near this long.
const LEFTOVER_AGE_MS = 60 * 60_000;

const sweepInstallLeftovers = async (dir: string, now: number): Promise<void> => {
    // allow(silent-catch): a folder that does not list yet holds nothing to sweep
    const names = (await readdir(dir).catch(() => [])).filter((name) => INSTALL_LEFTOVER.test(name));
    await Promise.all(
        names.map(async (name) => {
            const path = join(dir, name);
            // allow(silent-catch): a leftover that went meanwhile has nothing left to sweep
            const info = await stat(path).catch(() => undefined);
            if (info !== undefined && now - info.mtimeMs > LEFTOVER_AGE_MS) {
                await discard(path);
            }
        }),
    );
};

// A write into the folder, and a refusal of it by the PC said as the refusal it is (security-hint.ts) rather than as an
// errno. Any other failure goes on as it was.
const writing = async (file: string, write: () => Promise<void>): Promise<void> => {
    try {
        await write();
    } catch (error) {
        if (deniedByThePc(errnoCode(error))) {
            throw new Error(`${errorMessage(error)}. ${allowNote("write", file)}`, { cause: error });
        }
        throw error;
    }
};

// A cleanup that may find nothing to clean, or a file something still holds: the next install's sweep tries again.
const discard = async (path: string): Promise<void> => {
    try {
        await rm(path, { recursive: true, force: true });
    } catch (error) {
        daemonEventLog()?.(`could not remove ${path} (${errorMessage(error)}); the next Mutagen install sweeps it.`);
    }
};

// The bundle where Mutagen looks for it, or a plain account of why it is not there.
const assertBundle = (bundle: string, when: string): void => {
    if (!existsSync(bundle)) {
        throw new AgentBundleRemovedError(
            `Mutagen's agent bundle ${bundle} was gone ${when}, so file sync and port forwarding cannot install their agent in a sandbox. ${allowNote("removed", bundle)}`,
        );
    }
};

/**
 * The pinned Mutagen's missing parts into `dir`: the release unpacked into a staging folder inside it, then each part
 * renamed into place, so nothing in `dir` is ever half-written. A running executable is set aside as `.old` first, since
 * Windows renames one but never overwrites it, and put back when its replacement does not land. A bundle that is gone
 * right after it was unpacked, or right after it was moved into place, is said to be security software's doing.
 */
export const installPinnedMutagen = async (dir: string, need: Exclude<MutagenNeed, "nothing">, io: MutagenInstallIo = realInstallIo, now: number = Date.now()): Promise<void> => {
    await sweepInstallLeftovers(dir, now);
    const stamp = `${process.pid}-${now}`;
    const tarball = join(dir, `mutagen-${stamp}.tar.gz`);
    const staging = join(dir, `.mutagen-staging-${stamp}`);
    const dest = join(dir, `mutagen${exe}`);
    const bundle = join(dir, AGENT_BUNDLE);
    try {
        await writing(staging, async () => void (await mkdir(staging, { recursive: true })));
        await writing(tarball, async () => await io.fetch(tarball));
        await io.extract(tarball, staging);
        const stagedBundle = join(staging, AGENT_BUNDLE);
        assertBundle(stagedBundle, "right after it was unpacked");
        if (need === "all") {
            await placeExecutable(io, join(staging, `mutagen${exe}`), dest);
        }
        await writing(bundle, async () => await rename(stagedBundle, bundle));
        assertBundle(bundle, "right after it was put in place");
    } finally {
        await discard(staging);
        await discard(tarball);
    }
};

// The new executable over the old, which is set aside first and put back if the new one does not land.
const placeExecutable = async (io: MutagenInstallIo, staged: string, dest: string): Promise<void> => {
    if (!existsSync(staged)) {
        throw new Error(`the Mutagen ${MUTAGEN_VERSION} download held no mutagen${exe}. ${allowNote("removed", dest)}`);
    }
    await io.stopDaemon(dest);
    const displaced = `${dest}.old`;
    await renameIfPresent(dest, displaced);
    try {
        await writing(dest, async () => await rename(staged, dest));
    } catch (error) {
        // The copy that ran before is put back, so a refused replacement leaves the install as it was.
        await renameIfPresent(displaced, dest);
        throw error;
    }
    await chmod(dest, 0o755);
    // Windows may still hold a set-aside copy its daemon ran from; bin's sweep (release.ts LEFTOVER) takes it later.
    await discard(displaced);
};

// (2026-11-20, intentic#49) How long after one fetch of the bundle alone the next waits. A bundle security software
// removes would otherwise be fetched again, 97 MB at a time, by every pass and every report. The first is at once.
export const BUNDLE_REFETCH_MS = 30 * 60_000;

// The last fetch of the bundle alone, and what is wrong with this install as far as this process knows.
let lastBundleFetch: number | undefined;
let problem: string | undefined;
// One install at a time in this process: the watcher and a report asking at once share the one that is running.
let resolving: Promise<string> | undefined;

/** Why the pinned Mutagen cannot sync right now, in plain words, or undefined when nothing is known to be wrong. */
export const mutagenProblem = (): string | undefined => problem;

/** Whether a bundle-only fetch may run now: never fetched, or the last one is BUNDLE_REFETCH_MS old. Pure. */
export const bundleFetchDue = (last: number | undefined, now: number): boolean => last === undefined || now - last >= BUNDLE_REFETCH_MS;

// WHICH MUTAGEN THIS AGENT RUNS: its own pinned copy, downloaded when absent or another version, and an absolute path
// either way (see resolveOnPath). (2026-10-05) A Mutagen on PATH used to win, so the version that drove every session
// was whatever the owner had installed, and a daemon started by one version refused every client of another: each
// failed listing read as "no sessions" (the version mismatch in mutagen.ts). The pinned copy is what this agent was tested
// with, and the one whose daemon `recoverDaemon` (mutagen.ts) restarts. PATH's copy is used only when the pinned one cannot be had
// (offline at first start), so a machine with Mutagen installed still syncs while the download keeps failing.
// A pinned executable whose bundle is missing is still the one run: it lists, pauses and terminates sessions, and only
// making one needs the bundle, which is fetched beside it (mutagenNeed) and said in mutagenProblem when it cannot be.
export const ensureMutagen = async (): Promise<string> => {
    resolving ??= resolveMutagen().finally(() => {
        resolving = undefined;
    });
    return await resolving;
};

const resolveMutagen = async (): Promise<string> => {
    const dest = ownMutagenPath();
    const need = mutagenNeed(await installedVersion(dest, ["version"]), existsSync(agentBundlePath(dest)));
    if (need === "nothing") {
        problem = undefined;
        return dest;
    }
    const now = Date.now();
    if (need === "bundle" && !bundleFetchDue(lastBundleFetch, now)) {
        // Fetched once already in this window and gone again: the removal is the news, not the fetch.
        problem ??= `Mutagen's agent bundle ${agentBundlePath(dest)} keeps disappearing. ${allowNote("removed", agentBundlePath(dest))}`;
        return dest;
    }
    if (need === "bundle") {
        lastBundleFetch = now;
        daemonEventLog()?.(`Mutagen's agent bundle is missing from ${binDir}: fetching it again.`);
    }
    try {
        await installPinnedMutagen(binDir, need);
        problem = undefined;
        return dest;
    } catch (error) {
        problem = errorMessage(error);
        daemonEventLog()?.(`this agent's own Mutagen ${MUTAGEN_VERSION} is not whole: ${problem}`);
        // The executable may have landed with only the bundle refused, or been right all along: it is still the one run.
        if (need === "bundle" || (await installedVersion(dest, ["version"])) === MUTAGEN_VERSION) {
            lastBundleFetch = now;
            return dest;
        }
        const onPath = resolveOnPath("mutagen");
        if (onPath !== undefined && (await installedVersion(onPath, ["version"])) !== undefined) {
            daemonEventLog()?.(`this agent's own Mutagen ${MUTAGEN_VERSION} could not be fetched (${problem}); using ${onPath} until it can.`);
            return onPath;
        }
        throw error;
    }
};

/**
 * The watcher's check, once per pass: the pinned Mutagen it runs has lost its bundle (security software, a cleanup), so
 * the bundle is fetched again now rather than at the next start. A Mutagen off PATH is not this agent's to repair.
 */
export const repairAgentBundle = async (mutagen: string): Promise<void> => {
    if (mutagen === ownMutagenPath() && !existsSync(agentBundlePath(mutagen))) {
        await ensureMutagen();
    }
};
