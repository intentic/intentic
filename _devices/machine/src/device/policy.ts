import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract";

// The enforcement point: every scope the owner ticked is checked here, on the machine, and nowhere else. The
// sandbox only asks; a compromised sandbox cannot widen what happens on this device. A refusal is a value, not
// an exception: it names which switch is off so the agent can tell the user.

export class ScopeError extends Error {}

// The directories reads and writes are confined to. Empty config means the user's home.
export const rootsOf = (scopes: DeviceScopes): string[] => {
    const declared = (scopes.roots ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        // A leading ~ is what a user types; nothing expands it for us here (it arrives as data from a form).
        .map((line) => (line.startsWith("~") ? join(homedir(), line.slice(1)) : line))
        .filter((line) => isAbsolute(line))
        .map((line) => resolve(line));
    return declared.length > 0 ? declared : [resolve(homedir())];
};

// A separator-aware prefix test on normalized paths, so `/home/me/../etc/passwd` normalizes first and
// `/home/meeting` isn't treated as inside `/home/me`. Links are assertPath's to resolve, before this is asked.
export const withinRoots = (path: string, roots: readonly string[]): boolean => {
    const target = resolve(path);
    return roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
};

// Where `path` really is, every symlink and junction on the way resolved. A path that does not exist yet is its
// nearest existing ancestor, resolved, with the rest appended: a new file is judged by the folder it lands in.
export const realPathOf = async (path: string): Promise<string> => {
    const absolute = resolve(path);
    try {
        return await realpath(absolute);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const parent = dirname(absolute);
        if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === absolute) {
            throw error;
        }
        return join(await realPathOf(parent), basename(absolute));
    }
};

// Throws unless `path`, links resolved, is inside the roots, and answers with that real path: the one to operate on.
// `link: "itself"` judges a link where it sits rather than where it leads, for a move, which acts on the link.
export const assertPath = async (
    path: string,
    scopes: DeviceScopes,
    intent: string,
    { link = "follow" }: { readonly link?: "follow" | "itself" } = {},
): Promise<string> => {
    const roots = rootsOf(scopes);
    const absolute = resolve(path);
    // A link swapped in after this check takes a command to make, and a command already reaches past the roots.
    const real = link === "follow" ? await realPathOf(absolute) : join(await realPathOf(dirname(absolute)), basename(absolute));
    // The roots resolved too, or one that is itself a link (macOS's /tmp) would refuse everything under it.
    if (!withinRoots(real, await Promise.all(roots.map(realPathOf)))) {
        const leads = real === absolute ? "" : ` (it leads to ${real})`;
        throw new ScopeError(
            `Refused to ${intent} "${path}"${leads}: it is outside the folders this device allows (${roots.join(", ")}). ` +
                `Widen "Folders it may touch" on this device's capability card to change that.`,
        );
    }
    return real;
};

// Throws unless the named switch is on. One message shape for all of them, naming the card's own label.
export const assertScope = (
    scopes: DeviceScopes,
    scope: "shell" | "write" | "screen" | "control" | "sandboxes" | "destructive",
): void => {
    if (scopes[scope] === "on") {
        return;
    }
    const label = {
        shell: "Run commands",
        write: "Create and change files",
        screen: "See the screen",
        control: "Use the mouse and keyboard",
        sandboxes: "Manage sandboxes on this device",
        destructive: "Run destructive commands",
    }[scope];
    throw new ScopeError(`Refused: "${label}" is switched off for this device. Turn it on in its capability card to allow this.`);
};
