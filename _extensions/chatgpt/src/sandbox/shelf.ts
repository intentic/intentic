import { constants } from "node:fs";
import { access, lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { realInside } from "@intentic/base/contained";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { KitRefusal, type SavedFile } from "../kit/index.js";

// THE ARTIFACTS SHELF as the kit in a sandbox browser reaches it (2026-11-26, moved from the daemon's browser tools): a
// file the agent attaches leaves only from the shelf, and what ChatGPT made lands on it, in `chatgpt/`, beside `chrome/`
// (what the person's own browser saves) and `browser/` (the sandbox browser's captures). The rules are the ones the
// person's browser keeps for `upload_file`: a regular file whose real path, every link followed, is on the shelf, and
// no larger than one file a page takes.

// Relative to the workspace root.
export const SHELF_REL = `${STATE_GROUP_DIR.records}/artifacts`;
export const CHATGPT_SAVED_REL = `${SHELF_REL}/chatgpt`;

// The most one file carries either way, as the owner's browser's door holds it (the contract's WEBEXT_MEDIA_MAX_BYTES).
export const MEDIA_MAX_BYTES = 50 * 1024 * 1024;

// A file on the shelf, vetted, as the browser is handed it.
export interface ShelfFile {
    readonly path: string;
    readonly name: string;
    readonly bytes: number;
}

const SHELF_HINT = `Only files on the artifacts shelf (${SHELF_REL}/, chat attachments included) can be put into a page: copy the file there first.`;

type Vetted = { readonly ok: true; readonly file: ShelfFile } | { readonly ok: false; readonly refusal: string };

const refused = (refusal: string): Vetted => ({ ok: false, refusal });

// The file `asked` names (absolute, or relative to the workspace root), or why it may not go to ChatGPT.
const vetted = async (root: string, asked: string): Promise<Vetted> => {
    const path = isAbsolute(asked) ? asked : join(root, asked);
    const real = await realInside(join(root, SHELF_REL), path);
    if (real === undefined) {
        return refused(`${asked} is not on the artifacts shelf. ${SHELF_HINT}`);
    }
    // allow(silent-catch): a missing file is the refusal below
    const stat = await lstat(real).catch(() => undefined);
    if (stat === undefined) {
        return refused(`There is no file at ${asked}.`);
    }
    if (!stat.isFile()) {
        return refused(`${asked} is not a file.`);
    }
    if (stat.size === 0) {
        return refused(`${asked} is empty.`);
    }
    if (stat.size > MEDIA_MAX_BYTES) {
        return refused(`${asked} is ${Math.round(stat.size / 1_048_576)} MB; a page takes at most ${MEDIA_MAX_BYTES / 1_048_576} MB from the sandbox.`);
    }
    const readable = await access(real, constants.R_OK).then(
        () => true,
        () => false,
    );
    if (!readable) {
        return refused(`The browser cannot read ${asked}: its permissions keep the browser out. Make it readable (chmod a+r ${real}) and call again.`);
    }
    return { ok: true, file: { path: real, name: basename(real), bytes: stat.size } };
};

/** Every file vetted before anything is sent; the first that may not go refuses the call. */
export const collectShelfFiles = async (root: string, given: readonly string[]): Promise<ShelfFile[]> => {
    const files: ShelfFile[] = [];
    for (const asked of given) {
        const file = await vetted(root, asked);
        if (!file.ok) {
            throw new KitRefusal(`${file.refusal} Nothing was sent.`);
        }
        files.push(file.file);
    }
    return files;
};

// What a file's type is stored as; one not listed is stored as `.bin`, since only the name has to be honest.
const EXTENSIONS = new Map<string, string>([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
    ["image/avif", "avif"],
    ["text/markdown", "md"],
]);

// A suggested name made safe to be a file name and to be read back in a tool answer. Empty becomes "media".
const safeStem = (suggested: string): string => {
    const stem = suggested
        .normalize("NFKD")
        .replace(/\.[A-Za-z0-9]{1,5}$/u, "")
        .replace(/[^A-Za-z0-9._-]+/gu, "-")
        .replace(/-{2,}/gu, "-")
        .replace(/^[-.]+|[-.]+$/gu, "")
        .slice(0, 60);
    return stem === "" ? "media" : stem;
};

const MAX_NUMBERED = 999;

const taken = async (path: string): Promise<boolean> =>
    await access(path).then(
        () => true,
        () => false,
    );

// A name no earlier file in `dir` holds: `fox-2.png` after `fox.png`. An earlier save is some transcript's file.
const freeName = async (dir: string, name: string): Promise<string> => {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; n <= MAX_NUMBERED; n += 1) {
        const candidate = join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
        if (!(await taken(candidate))) {
            return candidate;
        }
    }
    return join(dir, `${stem}-${Date.now()}${ext}`);
};

/** Writes one file into the kit's directory on the shelf under a fresh name, never over an earlier one. */
export const storeOnShelf = async (root: string, bytes: Uint8Array, mimeType: string, suggested: string): Promise<SavedFile> => {
    const dir = join(root, CHATGPT_SAVED_REL);
    await mkdir(dir, { recursive: true });
    const target = await freeName(dir, `${safeStem(suggested)}.${EXTENSIONS.get(mimeType) ?? "bin"}`);
    // `wx`: a name taken between the look and the write fails here rather than overwriting.
    await writeFile(target, bytes, { flag: "wx" });
    return { path: target, bytes: bytes.byteLength, mimeType };
};
