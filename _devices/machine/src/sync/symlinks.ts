import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, errorMessage } from "@intentic/base/errors";
import { baseDir } from "../config.js";

// What a sync session does with the symbolic links it finds on either side. Mutagen fixes this at `sync create`, like
// the rest of a session's rules. `portable` is Mutagen's own default: it carries every relative link that stays inside
// the folder, and the sandbox writes those itself (every loaded skill is a `.claude/skills/<name>` link to
// `../../.agents/skills/<name>`). `ignore` carries no links, in either direction.
export type SymlinkMode = "portable" | "ignore";

export interface DeviceSymlinks {
    readonly mode: SymlinkMode;
    // Why links are left out: the refusal's error code, EPERM for Windows' missing privilege. Absent when they are carried.
    readonly refusal?: string | undefined;
}

// WINDOWS DOES NOT LET AN ORDINARY USER CREATE A SYMBOLIC LINK. It takes Developer Mode or an elevated token. A device
// with neither answers every link a portable session brings down with "A required privilege is not held by the
// client". Mutagen records that as a transition problem and attempts the same links again on the next cycle, and on
// every cycle after that, for as long as the session lives. Measured on a user's PC: the five `.claude/skills` links,
// failing in two copies of every session, until the machine slowed down enough for them to go looking.
// Only Windows is asked. Everywhere else an ordinary user creates links freely, and a session whose rules change is
// recreated from scratch, which no device there needs.
export const deviceSymlinks = async (
    platform: NodeJS.Platform = process.platform,
    probe: () => Promise<string | undefined> = async () => await symlinkRefusal(baseDir),
): Promise<DeviceSymlinks> => {
    if (platform !== "win32") {
        return { mode: "portable" };
    }
    const refusal = await probe();
    return refusal === undefined ? { mode: "portable" } : { mode: "ignore", refusal };
};

const PROBE_PREFIX = "symlink-probe-";

// Why this process cannot create a symbolic link inside `dir`, or undefined when it can. Asked the way Mutagen will
// be: a relative link to a file beside it. Node, Bun and Go all pass the unprivileged-create flag that Developer Mode
// honours, so a link this agent can make is one Mutagen's daemon, running as the same user, can make too. `dir` is
// this agent's own folder, on the profile volume the default sync folders (~/intentic/<id>) share.
export const symlinkRefusal = async (dir: string): Promise<string | undefined> => {
    await mkdir(dir, { recursive: true });
    const scratch = await mkdtemp(join(dir, PROBE_PREFIX));
    const refusal = await linkRefusal(scratch);
    // allow(silent-catch): the probe already has its answer. A scratch folder Windows has not let go of yet is two
    // empty entries in this agent's own directory; failing the pairing's file sync over it would be the real harm.
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    return refusal;
};

// A failure to write the target counts as a refusal too. On Windows the answer to "cannot tell" has to be "leave
// links out", since the other answer is the endless retry above. The reason is the error's code where it has one
// (EPERM is the missing privilege), not its message. The message names the scratch folder's random suffix, and a line
// that differs on every probe is never quieted by the watcher's rule for repeated lines (repeats.ts).
const linkRefusal = async (scratch: string): Promise<string | undefined> => {
    try {
        await writeFile(join(scratch, "target"), "");
        await symlink("target", join(scratch, "link"), "file");
        return undefined;
    } catch (error) {
        return errnoCode(error) ?? errorMessage(error);
    }
};
