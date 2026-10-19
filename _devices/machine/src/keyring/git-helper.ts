import { runBounded } from "@intentic/base/process";
import { keyringPath } from "../release.js";
import { KeyringCliError } from "./flags.js";

// git's credential helper pointed at the keyring (`intentic-keyring git-credential`, the keyring's README): a line in
// the user's global git config, ahead of any helper already there so git asks Passwords first and the others after.
// Removing it takes out that line alone. A shell snippet (`!…`) because the path may hold spaces; git appends the
// action (get, store, erase) after it.

/** The `credential.helper` value for the keyring at `path`. Pure. */
const gitHelperValue = (path: string): string => `!"${path.replaceAll("\\", "/")}" git-credential`;

const isOurs = (helper: string): boolean => /intentic-keyring[^"]*"? git-credential$/u.test(helper);

/**
 * The helpers in the order git should try them, the keyring's first: right after the last empty entry, since an empty
 * `credential.helper` clears every helper listed before it. Pure.
 */
const orderedHelpers = (existing: readonly string[], ours: string): string[] => {
    const others = existing.filter((helper) => !isOurs(helper));
    const reset = others.lastIndexOf("");
    return [...others.slice(0, reset + 1), ours, ...others.slice(reset + 1)];
};

const git = async (args: readonly string[]): Promise<{ readonly code: number | null; readonly out: string; readonly missing: boolean }> => {
    const result = await runBounded("git", [...args], { timeoutMs: 20_000 });
    return { code: result.exitCode, out: result.stdout.text, missing: result.spawnError !== undefined };
};

const helpers = async (): Promise<string[] | undefined> => {
    const listed = await git(["config", "--global", "--get-all", "credential.helper"]);
    if (listed.missing) {
        return undefined;
    }
    // Exit 1: no helper set at all.
    return listed.code === 0 ? listed.out.split(/\r?\n/u).filter((line, index, all) => line !== "" || index < all.length - 1) : [];
};

const write = async (list: readonly string[]): Promise<void> => {
    // Exit 5: nothing to unset, which is fine.
    const cleared = await git(["config", "--global", "--unset-all", "credential.helper"]);
    if (cleared.code !== 0 && cleared.code !== 5) {
        throw new KeyringCliError("failed", "git would not change its credential helpers.");
    }
    for (const helper of list) {
        const added = await git(["config", "--global", "--add", "credential.helper", helper]);
        if (added.code !== 0) {
            throw new KeyringCliError("failed", "git would not take the keyring as a credential helper.");
        }
    }
};

export interface GitHelperState {
    readonly available: boolean;
    readonly installed: boolean;
}

export const gitHelperStatus = async (path: string = keyringPath): Promise<GitHelperState> => {
    const list = await helpers();
    return { available: list !== undefined, installed: list?.includes(gitHelperValue(path)) === true };
};

/** The keyring first among git's helpers. Refused where git is not installed. */
export const installGitHelper = async (path: string = keyringPath): Promise<GitHelperState> => {
    const list = await helpers();
    if (list === undefined) {
        throw new KeyringCliError("unavailable", "git is not installed here, so there is no credential helper to set.");
    }
    const ordered = orderedHelpers(list, gitHelperValue(path));
    if (ordered.join("\n") !== list.join("\n")) {
        await write(ordered);
    }
    return { available: true, installed: true };
};

export const uninstallGitHelper = async (): Promise<GitHelperState> => {
    const list = await helpers();
    if (list === undefined) {
        return { available: false, installed: false };
    }
    const kept = list.filter((helper) => !isOurs(helper));
    if (kept.length !== list.length) {
        await write(kept);
    }
    return { available: true, installed: false };
};
