import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { HostScopes } from "@intentic/sandbox-contract";

/* THE ENFORCEMENT POINT. Every scope the owner ticked on the capability card is checked here, on the machine
 * itself, and nowhere else.
 *
 * That placement is the whole security argument for this feature. The sandbox could be compromised; the agent
 * running in it reads the open internet all day and can be talked into things. Neither can widen what happens on
 * this computer, because the sandbox does not decide — it only asks, and this file answers. The daemon never
 * checks a scope, so there is no second implementation to drift out of agreement with this one.
 *
 * A refusal is a VALUE, not an exception: it travels back as an ordinary tool result saying which switch is off,
 * so the agent tells the user what to flip instead of reporting a broken sandbox and retrying. */

export class ScopeError extends Error {}

// The directories reads and writes are confined to. Empty config ⇒ the user's home, which is the boundary the
// card promises when the field is left blank.
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

/* Is this path inside one of the roots? Compared on RESOLVED paths with a separator-aware prefix test, so
 * `/home/me/../etc/passwd` is normalized before it is judged and `/home/meeting` is not treated as being inside
 * `/home/me`. Symlinks are deliberately not chased: resolving them would make the check depend on the state of
 * the filesystem at the moment of the call, and a link the agent itself just created could then move the
 * boundary. What the user sees on the card is a path prefix, so a path prefix is what is enforced. */
export const withinRoots = (path: string, roots: readonly string[]): boolean => {
    const target = resolve(path);
    return roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
};

// Throws unless `path` is inside the roots. `intent` names the operation in the refusal, because "outside the
// folders you allowed" is only actionable when the user can see which file was reached for.
export const assertPath = (path: string, scopes: HostScopes, intent: string): string => {
    const roots = rootsOf(scopes);
    if (!withinRoots(path, roots)) {
        throw new ScopeError(
            `Refused to ${intent} "${path}": it is outside the folders this computer allows (${roots.join(", ")}). ` +
                `Widen "Folders it may touch" on this computer's capability card to change that.`,
        );
    }
    return resolve(path);
};

// Throws unless the named switch is on. One message shape for all three, naming the card's own label so the
// user is told exactly which control to flip.
export const assertScope = (scopes: HostScopes, scope: "shell" | "write" | "screen" | "control"): void => {
    if (scopes[scope] === "on") {
        return;
    }
    const label = {
        shell: "Run commands",
        write: "Create and change files",
        screen: "See the screen",
        control: "Use the mouse and keyboard",
    }[scope];
    throw new ScopeError(`Refused: "${label}" is switched off for this computer. Turn it on in its capability card to allow this.`);
};
