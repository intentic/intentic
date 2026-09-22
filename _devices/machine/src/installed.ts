import { realpathSync, statSync } from "node:fs";
import { agentPath, versionOf } from "./release.js";
import { MACHINE_VERSION } from "./version.js";

// Which build is installed on this machine (the file at `agentPath`), as opposed to which one is running
// (resident.ts's readResidentBuild): replacing the binary doesn't touch a live process, so the two drift, and a
// reader that only asks the compiled-in version can report a build the agent stopped serving releases ago.
// When this process IS that unchanged file, its own compiled version is free; otherwise the file is asked what
// it is, once per version of it. No installed agent at all answers undefined, read as "not known".

// The file at that path, as much of its identity as this needs: any swap changes its size or its mtime.
const identity = (): string | undefined => {
    try {
        const info = statSync(agentPath);
        return `${info.size}:${Math.round(info.mtimeMs)}`;
    } catch {
        return undefined;
    }
};

// Both read once, at startup: what we were launched from, and what was at `agentPath` when we were. Read later
// they'd answer about a file that may have already been replaced.
const STARTED_FROM = identity();
const IS_INSTALLED_AGENT = ((): boolean => {
    try {
        return realpathSync(process.execPath) === realpathSync(agentPath);
    } catch {
        return false;
    }
})();

// Whether this process IS the installed agent, as opposed to a dev run or a binary somebody is trying from Downloads.
export const runningAsInstalledAgent = (): boolean => IS_INSTALLED_AGENT;

// One probe per version of the file: the resident agent asks on every report it builds.
let probed: { readonly of: string; readonly version: string | undefined } | undefined;

const probe = (of: string): string | undefined => {
    if (probed?.of === of) {
        return probed.version;
    }
    const version = versionOf(agentPath);
    probed = { of, version };
    return version;
};

// The decision, pure and on its own: three cases, and the middle one (the file was replaced under a still-running
// process) is the whole point of the module. `own` is the version compiled into whoever is asking, and is the
// right answer both when the file at the path IS us and when there is no file there at all.
export const buildOf = (
    at: string | undefined,
    started: { readonly at: string | undefined; readonly ours: boolean },
    own: string,
    ask: (at: string) => string | undefined,
): string | undefined => {
    if (at === undefined) {
        return own;
    }
    return started.ours && at === started.at ? own : ask(at);
};

export const installedBuild = (): string | undefined => buildOf(identity(), { at: STARTED_FROM, ours: IS_INSTALLED_AGENT }, MACHINE_VERSION, probe);
