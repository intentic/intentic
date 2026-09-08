import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { HostScopes } from "@intentic/sandbox-contract";

// The enforcement point: every scope the owner ticked is checked here, on the machine, and nowhere else. The
// sandbox only asks; a compromised sandbox cannot widen what happens on this device. A refusal is a value, not
// an exception: it names which switch is off so the agent can tell the user.

export class ScopeError extends Error {}

// The directories reads and writes are confined to. Empty config means the user's home.
export const rootsOf = (scopes: HostScopes): string[] => {
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

// Compared on resolved paths with a separator-aware prefix test, so `/home/me/../etc/passwd` normalizes first
// and `/home/meeting` isn't treated as inside `/home/me`. Symlinks are not chased, since resolving them would
// make the check depend on filesystem state the agent could itself have just changed.
export const withinRoots = (path: string, roots: readonly string[]): boolean => {
    const target = resolve(path);
    return roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
};

// Throws unless `path` is inside the roots. `intent` names the operation in the refusal so the user can see
// which file was reached for.
export const assertPath = (path: string, scopes: HostScopes, intent: string): string => {
    const roots = rootsOf(scopes);
    if (!withinRoots(path, roots)) {
        throw new ScopeError(
            `Refused to ${intent} "${path}": it is outside the folders this device allows (${roots.join(", ")}). ` +
                `Widen "Folders it may touch" on this device's capability card to change that.`,
        );
    }
    return resolve(path);
};

// Throws unless the named switch is on. One message shape for all of them, naming the card's own label.
export const assertScope = (
    scopes: HostScopes,
    scope: "shell" | "write" | "screen" | "control" | "sandboxes" | "sandboxRemove" | "destructive",
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
        sandboxRemove: "Remove sandboxes from this device",
        destructive: "Run destructive commands",
    }[scope];
    throw new ScopeError(`Refused: "${label}" is switched off for this device. Turn it on in its capability card to allow this.`);
};
