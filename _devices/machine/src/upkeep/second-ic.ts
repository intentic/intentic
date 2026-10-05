import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { icCandidates, icVersionFrom } from "../device/tools/ic-binary.js";
import type { UpkeepEntry } from "./entry.js";

/* A SECOND `ic` ON PATH. The agent runs its own `~/.intentic/ic/bin/ic` and keeps it as new as itself
   (device/tools/ic-binary.ts), but a person typing `ic` gets whichever PATH finds first, and a root install's
   `/usr/local/bin/ic` is never updated: nothing here may write there without sudo. So it is reported, never changed. */

const exec = promisify(execFile);

// Where PATH's `ic` is, the way a shell would find it.
const icOnPath = async (platform: NodeJS.Platform): Promise<string | undefined> => {
    const lookup =
        platform === "win32"
            ? exec(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "where.exe"), ["ic"], { windowsHide: true, timeout: 30_000 })
            : exec("sh", ["-c", "command -v ic"], { timeout: 30_000 });
    // allow(silent-catch): no `ic` on PATH is the answer "none", which shadows nothing
    const first = (await lookup.catch(() => ({ stdout: "" }))).stdout.split(/\r?\n/)[0]?.trim();
    return first === undefined || first === "" ? undefined : first;
};

const versionOf = async (binary: string): Promise<string> =>
    // allow(silent-catch): an ic that will not say its version is reported as such
    icVersionFrom((await exec(binary, ["--version"], { windowsHide: true, timeout: 30_000 }).catch(() => ({ stdout: "" }))).stdout) ?? "unknown";

// One path as the platform compares it: through links (a user install links ~/.local/bin/ic to the agent's own), and
// case-folded on Windows.
const canonical = async (path: string, platform: NodeJS.Platform): Promise<string> => {
    // allow(silent-catch): a path that will not resolve is compared as written
    const real = await realpath(path).catch(() => path);
    return platform === "win32" ? real.toLowerCase() : real;
};

// The skip line for a shadowing ic, both versions named so a person can tell a harmless twin from a stale one. Pure.
export const shadowLine = (path: string, version: string, own: string): string =>
    `a second ic at ${path} (version ${version}) shadows the agent's (${own}); it cannot be updated from here without sudo`;

const secondIc: UpkeepEntry = {
    id: "second-ic",
    kind: "ic",
    action: "report",
    reason: "an `ic` other than the agent's own, found first on PATH",
    find: async ({ home, platform }) => {
        const own = icCandidates(platform, home)[0];
        const found = await icOnPath(platform);
        if (own === undefined || found === undefined || (await canonical(found, platform)) === (await canonical(own, platform))) {
            return [];
        }
        const [theirs, ours] = await Promise.all([versionOf(found), versionOf(own)]);
        return [{ what: found, why: shadowLine(found, theirs, ours) }];
    },
};

export const SECOND_IC_ENTRIES: readonly UpkeepEntry[] = [secondIc];
