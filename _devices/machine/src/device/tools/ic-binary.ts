import { execFile } from "node:child_process";
import { chmod, rename, rm } from "node:fs/promises";
import { homeDir } from "@intentic/local-agent";
import { promisify } from "node:util";
import { DEV_VERSION, DEVICE_FEATURE_RESHAPE_LATER, DEVICE_FEATURE_SET_SHAPE, type DeviceFeature, isNewer } from "@intentic/sandbox-contract";
import { archToken, download, exe, osToken } from "../../release.js";
import { MACHINE_VERSION } from "../../version.js";
import { errorMessage } from "@intentic/base/errors";

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
const userIcPath = (): string | undefined => icCandidates(process.platform, homeDir())[0];

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
    for (const candidate of icCandidates(process.platform, homeDir())) {
        // allow(silent-catch): a candidate that is missing or will not say its version is not the installed ic, and the next is tried
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are tried in order; the first that answers wins
        const answer = await exec(candidate, ["--version"], { timeout: 30_000, windowsHide: true }).catch(() => undefined);
        if (answer !== undefined) {
            return icVersionFrom(answer.stdout) ?? DEV_VERSION;
        }
    }
    return undefined;
};

// What a failed fetch leaves behind: one sentence naming the ic that stays, the one wanted and why it did not arrive.
// The newer verbs (logs, the contract's shape) are missing from the ic that stays, so the features this device reports
// shrink with no other explanation; this is that explanation, logged and reported beside them (hostFacts).
export const icStaleNote = (installed: string | undefined, agent: string, reason: string): string =>
    `ic is out of date: ${installed === undefined ? "none is installed" : `the installed ic is ${installed}`}, this agent is ${agent}, and fetching ic ${agent} failed (${reason}). Sandbox logs and saving a shape for the next restart need the newer ic; it is fetched again on the next sandbox action.`;

export interface IcFetchIo {
    readonly download: (url: string, to: string) => Promise<void>;
    readonly warn: (line: string) => void;
}

// Put `agent`'s release of ic at `target`. Download beside the target and rename into place, as the shims do:
// overwriting a running executable fails, and a half-downloaded binary must never be what runs. Answers undefined when
// the fetch landed, else the stale note, which is also logged: a failure is never silent, since what it costs (the
// verbs the old ic lacks) shows up far from here.
export const fetchIc = async (target: string, installed: string | undefined, agent: string, io: IcFetchIo): Promise<string | undefined> => {
    const part = `${target}.download`;
    try {
        await io.download(icAssetUrl(agent), part);
        if (process.platform !== "win32") {
            await chmod(part, 0o755);
        }
        await rename(part, target);
        return undefined;
    } catch (error) {
        // allow(silent-catch): a partial download that cannot be removed is overwritten by the next fetch; the failure that matters is reported below
        await rm(part, { force: true }).catch(() => undefined);
        const note = icStaleNote(installed, agent, errorMessage(error));
        io.warn(note);
        return note;
    }
};

// One check per process when it succeeds; a failed fetch is tried again on the next call, since the next call is a
// person pressing a button that needs it.
let checked: Promise<void> | undefined;
// The last failed fetch's note, until one lands.
let staleNote: string | undefined;

/** Why the ic this agent drives is older than the agent, when fetching the current one failed; undefined otherwise. */
export const icOutOfDate = (): string | undefined => staleNote;

const warn = (line: string): void => {
    process.stderr.write(`warning: ${line}\n`);
};

// Put this agent's own release of ic in the per-user location when what is installed is older (or missing). A fetch
// that fails leaves whatever is installed to answer for itself, and says so (icOutOfDate).
export const ensureCurrentIc = async (): Promise<void> => {
    checked ??= (async () => {
        const target = userIcPath();
        const installed = await installedVersion();
        if (target === undefined || !icNeedsFetch(installed, MACHINE_VERSION)) {
            staleNote = undefined;
            return;
        }
        staleNote = await fetchIc(target, installed, MACHINE_VERSION, { download, warn });
        if (staleNote !== undefined) {
            checked = undefined;
        }
    })();
    await checked;
};

/* WHAT THIS DEVICE CAN BE ASKED TO DO, derived from the `ic` it drives rather than written down beside the code: every
   optional op runs through ic, so an agent is only as capable as the ic under it. */

// A verb's help, from the first `ic` that answers; undefined when none does or this one does not know the verb (clap
// refuses an unknown subcommand with a usage error).
const helpOf = async (verb: readonly string[]): Promise<string | undefined> => {
    for (const candidate of icCandidates(process.platform, homeDir())) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are tried in order; the first that answers wins
        const answer = await exec(candidate, [...verb, "--help"], { timeout: 30_000, windowsHide: true }).then(
            ({ stdout }) => stdout,
            (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : ""),
        );
        if (answer !== undefined) {
            return answer === "" ? undefined : answer;
        }
    }
    return undefined;
};

// Which optional ops this device implements, from what its `ic`'s own help says it has. Both ride `ic sandbox shape`
// taking the contract's own shape (`--set`, the contract's `icShapeArgs`): `set-shape` directly, and the old `reshape`
// op's `later` through the same verb (sandboxes.ts, olderResizePlan). `reshape-later` is redundant with `set-shape`'s
// `when` for every current page, and is still advertised only for pages and daemons from before `set-shape` (v1.312.0
// and older), which check it before sending a later-reshape: REMOVE IN v1.314.0, with the old `reshape` op. Pure over
// the help, so the derivation is asserted without an ic.
export const featuresFrom = (shapeHelp: string | undefined): DeviceFeature[] =>
    shapeHelp?.includes("--set") === true ? [DEVICE_FEATURE_RESHAPE_LATER, DEVICE_FEATURE_SET_SHAPE] : [];

// Asked once per process when it answers: the agent keeps its ic current before asking (ensureCurrentIc), so the answer
// holds until the agent itself is replaced.
let features: Promise<DeviceFeature[]> | undefined;
export const deviceFeatures = async (): Promise<DeviceFeature[]> => {
    features ??= (async () => {
        await ensureCurrentIc();
        return featuresFrom(await helpOf(["sandbox", "shape"]));
    })();
    const answered = await features;
    if (answered.length === 0) {
        features = undefined;
    }
    return answered;
};
