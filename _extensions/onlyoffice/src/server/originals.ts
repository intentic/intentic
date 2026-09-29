import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { scratchBeside } from "./browser-engine.js";

// What a document on the user's own computer held before this process first wrote over it, kept in the app's cache
// (never beside the document): an editor's save is a change the user can take back in one click, whatever they did
// in between. One folder per document, named by the hash of its real path, holds each kept copy under the time it was
// kept, and `meta.json` names the latest. Only the first overwrite a process makes of a document keeps one, so a
// session's autosaves all lead back to how the document was when the session began; a restore keeps what it replaces
// the same way, so restoring twice is undoing the restore. What is older than a week goes at the next start.

export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const META = "meta.json";

interface Meta {
    // The document's real path, and its name as it was kept.
    readonly path: string;
    readonly name: string;
    readonly keptAt: string;
}

// A meta.json as parsed, before anything in it is trusted.
interface MetaFields {
    readonly path?: unknown;
    readonly name?: unknown;
    readonly keptAt?: unknown;
}

const isMeta = (fields: MetaFields): fields is Meta => typeof fields.path === "string" && typeof fields.name === "string" && typeof fields.keptAt === "string";

// Read by hand rather than trusted: a meta.json is only ever this module's, but a cache is anyone's to damage.
const metaOf = (text: string): Meta | undefined => {
    try {
        const fields: MetaFields = JSON.parse(text) ?? {};
        return isMeta(fields) ? { path: fields.path, name: fields.name, keptAt: fields.keptAt } : undefined;
    } catch {
        // allow(silent-catch): a meta.json that is not JSON names nothing to keep or restore.
        return undefined;
    }
};

// A kept copy's name: when it was kept, in a spelling every file system takes (no colons), then the document's name.
const keptName = (keptAt: string, name: string): string => `${keptAt.replaceAll(":", "-")}-${name}`;

// When a kept copy was kept, read back off its name; undefined for a file that is not one.
const keptTime = (file: string): number | undefined => {
    const stamp = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)Z-/.exec(file);
    return stamp === null ? undefined : Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`);
};

export interface OriginalsDeps {
    // The app's cache dir for them: `<app cache>/office-originals`.
    readonly dir: string;
    readonly log: (line: string) => void;
    readonly now?: () => number;
    // How the restored bytes take the document's place: a rename, which Windows refuses while another program holds
    // the document. A test makes it fail.
    readonly replace?: (from: string, to: string) => Promise<void>;
}

export type Kept = { readonly kept: true; readonly keptAt: string } | { readonly kept: false };

export class Originals {
    // Documents this process has kept an original of, by real path: every later overwrite leaves it as it is.
    readonly #kept = new Set<string>();
    // One change at a time per document, so a save and a restore never interleave their copies.
    readonly #queue = new Map<string, Promise<unknown>>();

    constructor(private readonly deps: OriginalsDeps) {}

    #now(): number {
        return (this.deps.now ?? Date.now)();
    }

    #folder(real: string): string {
        return join(this.deps.dir, createHash("sha256").update(real).digest("hex").slice(0, 16));
    }

    async #meta(real: string): Promise<Meta | undefined> {
        // allow(silent-catch): no meta.json is no original kept, the ordinary case for a document never saved here.
        const text = await readFile(join(this.#folder(real), META), "utf8").catch(() => undefined);
        const meta = text === undefined ? undefined : metaOf(text);
        return meta?.path === real ? meta : undefined;
    }

    #serial<T>(real: string, task: () => Promise<T>): Promise<T> {
        const run = (this.#queue.get(real) ?? Promise.resolve()).then(task, task);
        const settled = run.then(
            () => undefined,
            () => undefined,
        );
        this.#queue.set(real, settled);
        void settled.then(() => {
            if (this.#queue.get(real) === settled) {
                this.#queue.delete(real);
            }
        });
        return run;
    }

    // Where a kept copy's bytes are.
    #keptFile(meta: Meta): string {
        return join(this.#folder(meta.path), keptName(meta.keptAt, meta.name));
    }

    // Copies the document as it is now into its folder, and answers the meta.json that would name it the original. Never
    // over another kept copy, which may be the only one of its bytes left.
    async #copyAside(real: string): Promise<Meta> {
        const meta: Meta = { path: real, name: basename(real), keptAt: new Date(this.#now()).toISOString() };
        await mkdir(this.#folder(real), { recursive: true });
        await copyFile(real, this.#keptFile(meta), constants.COPYFILE_EXCL);
        return meta;
    }

    // Names a copy made aside the original: meta.json written whole, or not at all.
    async #commit(meta: Meta): Promise<void> {
        const temporary = join(this.#folder(meta.path), `${META}.${randomBytes(4).toString("hex")}.tmp`);
        await writeFile(temporary, JSON.stringify(meta));
        await rename(temporary, join(this.#folder(meta.path), META));
    }

    // The original kept of the document at its real path, if one is.
    async original(real: string): Promise<Kept> {
        const meta = await this.#meta(real);
        return meta === undefined ? { kept: false } : { kept: true, keptAt: meta.keptAt };
    }

    // Keeps the document as it is on disk, the first time this process is about to write over it. A copy that cannot be
    // made is logged and the write goes ahead: losing the chance to restore is better than losing the edit.
    beforeOverwrite(real: string): Promise<void> {
        return this.#serial(real, async () => {
            if (this.#kept.has(real)) {
                return;
            }
            try {
                await this.#commit(await this.#copyAside(real));
                this.#kept.add(real);
            } catch (error) {
                this.deps.log(`could not keep the original of ${real}: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    // Puts the kept original back over the document, keeping what is there now as the original once it is back. A put
    // that fails (Windows refuses to replace a document another program holds) leaves the document and the original as
    // they were, so it can be tried again. False when nothing is kept for it.
    restore(real: string): Promise<boolean> {
        return this.#serial(real, async () => {
            const meta = await this.#meta(real);
            const source = meta === undefined ? undefined : this.#keptFile(meta);
            // allow(silent-catch): a kept copy swept or removed since its meta.json was written is nothing to restore.
            if (source === undefined || (await stat(source).catch(() => undefined)) === undefined) {
                return false;
            }
            const replaced = await this.#copyAside(real);
            // Whole or not at all: the kept bytes land beside the document and replace it by rename.
            const temporary = scratchBeside(real);
            try {
                await copyFile(source, temporary);
                await (this.deps.replace ?? rename)(temporary, real);
            } catch (error) {
                await rm(temporary, { force: true });
                await rm(this.#keptFile(replaced), { force: true });
                throw error;
            }
            await this.#commit(replaced);
            this.#kept.add(real);
            return true;
        });
    }

    // Removes every copy kept more than a week ago, and a document's folder once nothing current is left in it.
    async sweep(): Promise<void> {
        const cutoff = this.#now() - KEEP_MS;
        // allow(silent-catch): no folder yet is nothing to sweep.
        const folders = await readdir(this.deps.dir).catch(() => []);
        for (const name of folders) {
            const folder = join(this.deps.dir, name);
            // allow(silent-catch): a folder with no meta.json left to read names nothing current, and goes.
            // oxlint-disable-next-line eslint/no-await-in-loop -- one document's folder at a time, at start, off every request's path
            const meta = metaOf((await readFile(join(folder, META), "utf8").catch(() => ``)) ?? ``);
            if (meta === undefined || Date.parse(meta.keptAt) < cutoff) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- as above
                await rm(folder, { recursive: true, force: true });
                continue;
            }
            // allow(silent-catch): a folder gone since it was listed holds nothing left to sweep.
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above
            const old = (await readdir(folder).catch(() => [])).filter((file) => (keptTime(file) ?? Number.POSITIVE_INFINITY) < cutoff);
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above
            await Promise.all(old.map((file) => rm(join(folder, file), { force: true })));
        }
    }
}
