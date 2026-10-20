import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { binDir } from "../../config.js";
import { archToken, download, exe, osToken, renameIfPresent } from "../../release.js";
import { runProcess } from "../exec.js";
import { daemonEventLog, MUTAGEN_CALL_TIMEOUT_MS } from "../mutagen.js";

// Which Mutagen binary this agent runs, and getting it: the pinned copy in this agent's own bin, downloaded and
// unpacked when absent or another version, with PATH's copy as the fallback.

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

// Extract a gzipped tarball into this agent's own bin using the system `tar` (bsdtar on macOS/Windows 10+).
// Not blocking, since GNU tar runs gzip as a child of its own and a stuck one would hold the agent's event loop; the
// deadline ends both. tar's own reason, which it printed to the terminal while this call inherited it, is in the error.
const extractTarball = async (tarball: string): Promise<void> => {
    const extract = await runProcess("tar", ["-xzf", tarball, "-C", binDir], { timeoutMs: 2 * 60_000 });
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

// WHICH MUTAGEN THIS AGENT RUNS: its own pinned copy, downloaded when absent or another version, and an absolute path
// either way (see resolveOnPath). (2026-10-05) A Mutagen on PATH used to win, so the version that drove every session
// was whatever the owner had installed, and a daemon started by one version refused every client of another: each
// failed listing read as "no sessions" (the version mismatch in mutagen.ts). The pinned copy is what this agent was tested
// with, and the one whose daemon `recoverDaemon` (mutagen.ts) restarts. PATH's copy is used only when the pinned one cannot be had
// (offline at first start), so a machine with Mutagen installed still syncs while the download keeps failing.
export const ensureMutagen = async (): Promise<string> => {
    const dest = ownMutagenPath();
    if ((await installedVersion(dest, ["version"])) === MUTAGEN_VERSION) {
        return dest;
    }
    try {
        await installPinnedMutagen(dest);
        return dest;
    } catch (error) {
        const onPath = resolveOnPath("mutagen");
        if (onPath !== undefined && (await installedVersion(onPath, ["version"])) !== undefined) {
            daemonEventLog()?.(`this agent's own Mutagen ${MUTAGEN_VERSION} could not be fetched (${errorMessage(error)}); using ${onPath} until it can.`);
            return onPath;
        }
        throw error;
    }
};

const installPinnedMutagen = async (dest: string): Promise<void> => {
    // Stops any daemon from our copy first; on Windows that's what holds the file open. Best-effort.
    await runProcess(dest, ["daemon", "stop"], { timeoutMs: MUTAGEN_CALL_TIMEOUT_MS });
    const tarball = join(binDir, "mutagen.tar.gz");
    await download(
        `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_${osToken()}_${archToken()}_v${MUTAGEN_VERSION}.tar.gz`,
        tarball,
    );
    // Extraction writes in place, so the running copy is set aside first and dropped once the new one lands.
    const displaced = `${dest}.old`;
    await renameIfPresent(dest, displaced);
    await extractTarball(tarball);
    await chmod(dest, 0o755);
    await rm(displaced, { force: true }).catch(() => undefined);
    await rm(tarball, { force: true }).catch(() => undefined);
};
