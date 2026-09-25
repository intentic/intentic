import { execFile } from "node:child_process";
import { chmod, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { DEV_VERSION, isNewer } from "@intentic/sandbox-contract";
import { archToken, download, exe, osToken } from "../../release.js";
import { MACHINE_VERSION } from "../../version.js";

// WHICH `ic` THIS AGENT RUNS, and keeping it at least as new as the agent. Every sandbox verb here is an `ic` verb, so an
// agent that learned `ic sandbox list --json` or `ic sandbox shape` in the same release as ic did must not be left
// talking to the ic an install shim put down months ago. The shims download a fresh one on every run; this is the same
// download, for the machines where nobody has run a shim since.

const exec = promisify(execFile);

// Where `ic` is, in the order the installers put it: a root install writes /usr/local/bin, a user install writes under
// the home and symlinks ~/.local/bin, Windows only ever has the profile copy. PATH is the last resort, since a
// developer's global copy would answer here and nothing would answer on a real user's machine. The separator is chosen
// from the target platform, not from `node:path`, so the Windows spelling can be asserted from a Linux runner.
export const icCandidates = (platform: NodeJS.Platform, home: string | undefined): string[] => {
    if (platform === "win32") {
        return [...(home === undefined ? [] : [`${home}\\.intentic\\ic\\bin\\ic.exe`]), "ic.exe"];
    }
    return [...(home === undefined ? [] : [`${home}/.intentic/ic/bin/ic`]), "/usr/local/bin/ic", "ic"];
};

// The per-user install location, the one this agent may write without asking anybody: the first candidate.
const userIcPath = (): string | undefined => icCandidates(process.platform, homedir())[0];

// The release asset, named the way the shims fetch it (`ic-<os>-<arch>[.exe]`), from the agent's own release.
export const icAssetUrl = (version: string): string =>
    `https://github.com/intentic/intentic/releases/download/v${version}/ic-${osToken()}-${archToken()}${exe}`;

// What `ic --version` prints (`ic 1.4.2`), read back; undefined for anything else.
export const icVersionFrom = (stdout: string): string | undefined => /^ic (\d+\.\d+\.\d+)\s*$/.exec(stdout.trim())?.[1];

// Whether an installed ic (its version, or undefined when none answered) is too old for this agent. A working-tree
// agent (DEV_VERSION) never fetches: whatever the developer built is what they meant, and there is no release to fetch.
export const icNeedsFetch = (installed: string | undefined, agent: string): boolean =>
    agent !== DEV_VERSION && (installed === undefined || isNewer(agent, installed));

const installedVersion = async (): Promise<string | undefined> => {
    for (const candidate of icCandidates(process.platform, homedir())) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are tried in order; the first that answers wins
        const answer = await exec(candidate, ["--version"], { timeout: 30_000, windowsHide: true }).catch(() => undefined);
        if (answer !== undefined) {
            return icVersionFrom(answer.stdout) ?? DEV_VERSION;
        }
    }
    return undefined;
};

// One check per process when it succeeds; a failed fetch is tried again on the next call, since the next call is a
// person pressing a button that needs it.
let checked: Promise<void> | undefined;

// Put this agent's own release of ic in the per-user location when what is installed is older (or missing). Download
// beside the target and rename into place, as the shims do: overwriting a running executable fails, and a half-downloaded
// binary must never be what runs. A fetch that fails leaves whatever is installed to answer for itself.
export const ensureCurrentIc = async (): Promise<void> => {
    checked ??= (async () => {
        const target = userIcPath();
        if (target === undefined || !icNeedsFetch(await installedVersion(), MACHINE_VERSION)) {
            return;
        }
        const part = `${target}.download`;
        try {
            await download(icAssetUrl(MACHINE_VERSION), part);
            if (process.platform !== "win32") {
                await chmod(part, 0o755);
            }
            await rename(part, target);
        } catch (error) {
            await rm(part, { force: true });
            checked = undefined;
            throw error;
        }
    })();
    await checked.catch(() => undefined);
};
