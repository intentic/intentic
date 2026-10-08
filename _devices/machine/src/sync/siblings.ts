import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { undefinedIfMissing } from "@intentic/base/errors";
import { z } from "zod";
import { heldDistros, windowsRoot } from "../environments/machine.js";
import { registeredDistro, WINDOWS_SIDE } from "../environments/wsl.js";

// THE OTHER ENVIRONMENTS OF THIS PC, AS FOLDER SYNC SEES THEM (2026-10-05). Each environment keeps its own `sync.json`,
// so the rule "one folder, one sync" (folders.ts) was only ever checked within one: the Windows side could pair
// `C:\code\app` while a distro synced `/mnt/c/code/app`, two synchronizers over one folder on behalf of two sandboxes,
// each carrying the other's writes as edits. A setup or an attach now also reads the other side's pairings and compares
// the folders after putting both into one spelling (`comparableFolder`).
//
// From the Windows root: every supervised distro's `sync.json`, read with `wsl.exe -d <distro> cat`, the same crossing
// the children use. From a distro: the Windows side's `sync.json`, through the Windows agent the distro already finds
// (`windowsRoot`, environments/machine.ts). A side that cannot be read is said by name and skipped, never read as
// holding nothing: the check it could not make is not a refusal, and not a pass either, which the caller says.

const exec = promisify(execFile);

// A distro's listing through wsl.exe: a cold distro boots in a few seconds, and a stuck one must not hold a setup.
const READ_TIMEOUT_MS = 20_000;

/** One folder another environment of this PC syncs, as it spelled it. */
export interface SiblingFolder {
    // "windows", or "wsl:<distro>".
    readonly environment: string;
    readonly localDir: string;
    readonly sandboxId: string;
}

/** What reading the other environments found: their folders, and the ones that could not be read. */
export interface Siblings {
    readonly folders: readonly SiblingFolder[];
    readonly unread: readonly string[];
}

// The folders a `sync.json` holds, read leniently: only `localDir` and `sandboxId` matter here, a pairing without a
// folder (the projects host, a mirror-only one) has none, and a file this build cannot parse is unread rather than empty.
const SiblingStateSchema = z.object({ pairings: z.array(z.unknown()) });
const SiblingPairingSchema = z.object({ localDir: z.string(), sandboxId: z.string() });

export const siblingFoldersIn = (raw: string, environment: string): SiblingFolder[] | undefined => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // allow(silent-catch): a torn file is unread (above), which the caller names
        return undefined;
    }
    const state = SiblingStateSchema.safeParse(parsed);
    if (!state.success) {
        return undefined;
    }
    return state.data.pairings.flatMap((pairing) => {
        const held = SiblingPairingSchema.safeParse(pairing);
        return held.success ? [{ environment, localDir: held.data.localDir, sandboxId: held.data.sandboxId }] : [];
    });
};

const SYNC_JSON_IN_DISTRO = `cat "$HOME/.intentic/machine/sync.json" 2>/dev/null || true`;

const distroFolders = async (distro: string): Promise<SiblingFolder[] | undefined> => {
    const answer = await exec("wsl.exe", ["-d", distro, "--cd", "~", "--exec", "sh", "-c", SYNC_JSON_IN_DISTRO], {
        timeout: READ_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: "1" },
        // allow(silent-catch): a distro that would not start or answer in time is reported as unread, which readSiblings names to the caller.
    }).catch(() => undefined);
    if (answer === undefined) {
        return undefined;
    }
    // An agent installed there that never paired anything has no file: nothing synced, which is an answer.
    return answer.stdout.trim() === "" ? [] : siblingFoldersIn(answer.stdout, `wsl:${distro}`);
};

const windowsFolders = async (): Promise<SiblingFolder[] | undefined> => {
    const agent = await windowsRoot();
    if (agent === undefined) {
        return [];
    }
    // `<profile>/.intentic/machine/bin/intentic-machine.exe`: the state sits two folders up.
    const raw = await readFile(join(dirname(dirname(agent)), "sync.json"), "utf8").catch(undefinedIfMissing);
    return raw === undefined ? [] : siblingFoldersIn(raw, "windows");
};

export const readSiblings = async (): Promise<Siblings> => {
    if (WINDOWS_SIDE) {
        const distros = await heldDistros();
        const read = await Promise.all(distros.map(async (distro) => ({ environment: `wsl:${distro}`, folders: await distroFolders(distro) })));
        return {
            folders: read.flatMap((entry) => entry.folders ?? []),
            unread: read.filter((entry) => entry.folders === undefined).map((entry) => entry.environment),
        };
    }
    if ((await registeredDistro()) === undefined) {
        return { folders: [], unread: [] };
    }
    const folders = await windowsFolders();
    return { folders: folders ?? [], unread: folders === undefined ? ["windows"] : [] };
};

// ONE SPELLING FOR A FOLDER ON EITHER SIDE OF A PC, so a Windows path and a distro's path can be compared:
// - a drive folder is `drive:<letter>/<path>`, lower-cased, as NTFS compares it: `C:\Code\App` on Windows and
//   `/mnt/c/Code/App` in a distro are both `drive:c/code/app`;
// - a folder inside a distro's own filesystem is `wsl:<distro>/<path>`, case kept: `/home/ada/app` in Ubuntu, and
//   `\\wsl.localhost\Ubuntu\home\ada\app` (or `\\wsl$\...`) on Windows.
// Undefined for a spelling neither side can name (another network share), which overlaps nothing here.
export const comparableFolder = (folder: string, side: "windows" | "wsl", distro?: string): string | undefined => {
    if (side === "windows") {
        const resolved = win32.resolve(folder);
        const drive = /^([A-Za-z]):\\(.*)$/.exec(resolved);
        if (drive?.[1] !== undefined) {
            return `drive:${drive[1].toLowerCase()}/${(drive[2] ?? "").replaceAll("\\", "/").toLowerCase()}`.replace(/\/+$/, "");
        }
        const share = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i.exec(resolved);
        return share?.[1] === undefined ? undefined : `wsl:${share[1].toLowerCase()}${(share[2] ?? "").replaceAll("\\", "/")}`.replace(/\/+$/, "");
    }
    const resolved = posix.resolve(folder);
    const mounted = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(resolved);
    if (mounted?.[1] !== undefined) {
        return `drive:${mounted[1].toLowerCase()}${(mounted[2] ?? "").toLowerCase()}`.replace(/\/+$/, "");
    }
    return distro === undefined ? undefined : `wsl:${distro.toLowerCase()}${resolved === "/" ? "" : resolved}`;
};

// Whether two comparable folders are one, or one holds the other.
export const comparableOverlap = (first: string, second: string): boolean =>
    first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);

// The first folder another environment syncs that `folder` (this environment's, spelled as this side spells it) is,
// holds or sits inside; undefined when none does.
export const siblingClash = (
    folder: string,
    here: { readonly side: "windows" | "wsl"; readonly distro?: string | undefined },
    siblings: readonly SiblingFolder[],
): SiblingFolder | undefined => {
    const mine = comparableFolder(folder, here.side, here.distro);
    if (mine === undefined) {
        return undefined;
    }
    return siblings.find((sibling) => {
        const theirs =
            sibling.environment === "windows"
                ? comparableFolder(sibling.localDir, "windows")
                : comparableFolder(sibling.localDir, "wsl", sibling.environment.slice("wsl:".length));
        return theirs !== undefined && comparableOverlap(mine, theirs);
    });
};

// The sentence a refusal says, naming the other side by what a person calls it.
export const siblingClashSentence = (folder: string, clash: SiblingFolder): string =>
    `${folder} overlaps ${clash.localDir}, which ${clash.environment === "windows" ? "this PC's Windows side" : `this PC's WSL distro ${clash.environment.slice("wsl:".length)}`} already syncs with ${clash.sandboxId}: two syncs over one folder overwrite each other's files, from whichever side of the PC they run. Choose a folder neither side syncs, or unpair that one there first.`;

// Where this agent stands on its PC, for `siblingClash`: Windows, a distro (by its registered name), or undefined for a
// computer with no other side.
export const hereOnThisPc = async (): Promise<{ readonly side: "windows" | "wsl"; readonly distro?: string } | undefined> => {
    if (WINDOWS_SIDE) {
        return { side: "windows" };
    }
    const distro = await registeredDistro();
    return distro === undefined ? undefined : { side: "wsl", distro };
};

// Every refusal and note the other sides of this PC add to a folder about to be synced: a sentence to throw, or the
// environments that could not be asked (a note, since that check was not made).
export const refuseAcrossPc = async (
    folder: string,
    read: () => Promise<Siblings> = readSiblings,
): Promise<{ readonly refusal?: string; readonly unread: readonly string[] }> => {
    const here = await hereOnThisPc();
    if (here === undefined) {
        return { unread: [] };
    }
    const siblings = await read();
    const clash = siblingClash(folder, here, siblings.folders);
    return clash === undefined ? { unread: siblings.unread } : { refusal: siblingClashSentence(folder, clash), unread: siblings.unread };
};
