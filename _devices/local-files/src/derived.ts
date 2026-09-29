import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { estimateTokens } from "@intentic/base/format";
import { neutralizeOutsideText } from "@intentic/base/outside-text";
import { refuse } from "@intentic/contract-serve";
import type { Format } from "@intentic/fileq/formats";
import type { DerivedState, SidecarStatus, WorkspaceDerived } from "@intentic/sandbox-contract";
import { z } from "zod";
import { resolveExisting } from "./paths.js";
import { Turns } from "./turns.js";

// A document's text for the quick look, a picture's or a recording's description, rendered by fileq's own readers in
// memory. A sandbox keeps a shadow of each file beside it in the workspace; a folder on the user's disk is theirs, so
// nothing is ever written into it: each rendering is kept in the app's cache instead, under the file's real path, size,
// time and the reader's version, so a file that changes or a reader that improves renders afresh. Reading the text
// never renders it; only asking to does, one file at a time and bounded like the daemon's.

// An interactive rendering: long enough for a scanned PDF's recognition, short enough that a window is not left
// holding a request nobody will wait for. One that runs past it goes on and is kept when it lands.
export const DERIVE_TIMEOUT_MS = 120_000;

// What one answer carries: well past any real document's text, far under what a window should be sent at once.
const MAX_CONTENT_CHARS = 512 * 1024;

// Readers run two at a time, a few more waiting their turn: a reader cannot be stopped once it starts, so how long they
// hold the machine past a request's timeout is bounded by how many run (turns.ts).
const RENDERS_AT_ONCE = 2;
const RENDERS_WAITING = 8;
const BUSY = `Too many documents are being read right now. Ask again in a moment.`;

// No pass renders a folder in the background here: a document has text once someone asks for it, and only then.
export const QUEUE: SidecarStatus = { enabled: false, queued: 0, deriving: [], sweeping: false, broken: false };

// One rendering as the cache keeps it.
const CachedSchema = z.object({
    deriver: z.string(),
    derivedAt: z.string(),
    title: z.string().optional(),
    notes: z.array(z.string()),
    markdown: z.string(),
});
type Cached = z.infer<typeof CachedSchema>;

type Outcome = { readonly kind: `derived`; readonly cached: Cached } | { readonly kind: `failed`; readonly reason: string };

// fileq's readers (pdf.js, mammoth, exceljs and the rest), loaded the first time a document is asked about: a cost the
// rest of this process never needs to pay.
const loadFileq = async () => {
    const [derive, formats] = await Promise.all([import("@intentic/fileq/derive"), import("@intentic/fileq/formats")]);
    return { readers: derive.DERIVERS, maxBytes: derive.MAX_SOURCE_BYTES, detectFormat: formats.detectFormat };
};
let fileq: ReturnType<typeof loadFileq> | undefined;

// The reader's name and version, as fileq stamps a shadow with it (`docx v2`): a reader that changes renders afresh.
const stampOf = async (format: Format): Promise<string> => {
    const reader = (await (fileq ??= loadFileq())).readers[format];
    return `${reader.name} v${reader.version}`;
};

// A file to render: where it is, what makes this version of it, and the format a reader claims, if one does.
interface Source {
    readonly abs: string;
    readonly size: number;
    readonly mtimeMs: number;
    readonly format: Format | undefined;
}

// The file a path names, read like any other read (a document opened alone reads its folder); undefined for nothing
// there or not a file.
const sourceOf = async (root: string, path: string): Promise<Source | undefined> => {
    const resolved = await resolveExisting(root, path);
    if (resolved.kind === `refused`) {
        return refuse(resolved.why, 400);
    }
    // allow(silent-catch): a file gone since it resolved is the undefined that answers "nothing there".
    const found = resolved.kind === `found` ? await stat(resolved.abs).catch(() => undefined) : undefined;
    if (resolved.kind !== `found` || found?.isFile() !== true) {
        return undefined;
    }
    // allow(silent-catch): a file whose first bytes cannot be read has no format anyone can claim.
    const format = await (await (fileq ??= loadFileq())).detectFormat(resolved.abs).catch(() => undefined);
    return { abs: resolved.abs, size: found.size, mtimeMs: found.mtimeMs, format };
};

const absent = (path: string, derivable: boolean, state: DerivedState, reason?: string): WorkspaceDerived => {
    const answer: WorkspaceDerived = { present: false, path, derivable, state, queue: QUEUE };
    if (reason !== undefined) {
        answer.reason = reason;
    }
    return answer;
};

const present = (path: string, cached: Cached): WorkspaceDerived => {
    const content = cached.markdown.slice(0, MAX_CONTENT_CHARS);
    const answer: WorkspaceDerived = {
        present: true,
        path,
        content,
        state: `idle`,
        queue: QUEUE,
        deriver: cached.deriver,
        derivedAt: cached.derivedAt,
        notes: cached.notes,
        tokens: estimateTokens(content),
        truncated: content.length < cached.markdown.length,
        // The cache is keyed by the file's version: what it holds for this file is never of an older one.
        stale: false,
    };
    if (cached.title !== undefined) {
        answer.title = cached.title;
    }
    return answer;
};

export interface DerivedTextsDeps {
    // Where renderings are kept: the app's cache, never a folder it serves.
    readonly dir: string;
    readonly log: (line: string) => void;
    readonly timeoutMs?: number;
}

export class DerivedTexts {
    // Renderings under way, by cache key: two windows asking for one file wait on one reader.
    readonly #inFlight = new Map<string, Promise<Outcome>>();
    readonly #turns = new Turns(RENDERS_AT_ONCE, RENDERS_WAITING);
    // Told the real path of every rendering that ends, kept or failed (the windows' event streams, procedures.ts).
    readonly #landed = new Set<(abs: string) => void>();

    constructor(private readonly deps: DerivedTextsDeps) {}

    // Hears each rendering end, by the file's real path, until the returned function is called. A pane that read
    // `deriving` waits for exactly this: nothing else would tell it the text is there, since a rendering ends in the app's
    // cache, which no watch looks at.
    onLanded(listener: (abs: string) => void): () => void {
        this.#landed.add(listener);
        return () => this.#landed.delete(listener);
    }

    // What is kept for `path` as it is now, rendering nothing.
    async read(root: string, path: string): Promise<WorkspaceDerived> {
        const source = await sourceOf(root, path);
        if (source?.format === undefined) {
            return absent(path, false, `undeliverable`);
        }
        const key = await this.#keyOf(source, source.format);
        const cached = await this.#cached(key);
        if (cached !== undefined) {
            return present(path, cached);
        }
        return absent(path, true, this.#inFlight.has(key) ? `deriving` : `off`);
    }

    // Renders `path` now unless what is kept is current, and answers with the text or why there is none.
    async derive(root: string, path: string): Promise<WorkspaceDerived> {
        const source = await sourceOf(root, path);
        if (source === undefined) {
            return absent(path, false, `undeliverable`, `There is no file there to read.`);
        }
        if (source.format === undefined) {
            return absent(path, false, `undeliverable`, `Nothing here reads this kind of file.`);
        }
        const { maxBytes } = await (fileq ??= loadFileq());
        if (source.size > maxBytes) {
            return absent(path, true, `off`, `It is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, the most that is read as text.`);
        }
        const key = await this.#keyOf(source, source.format);
        const cached = await this.#cached(key);
        if (cached !== undefined) {
            return present(path, cached);
        }
        const outcome = await this.#bounded(this.#rendering(key, source, source.format));
        return outcome.kind === `derived` ? present(path, outcome.cached) : absent(path, true, `off`, outcome.reason);
    }

    // The cache's name for this version of this file as this reader renders it.
    async #keyOf(source: Source, format: Format): Promise<string> {
        const stamp = await stampOf(format);
        return createHash(`sha256`).update([source.abs, source.size, source.mtimeMs, stamp].join(`\0`)).digest(`hex`).slice(0, 40);
    }

    async #cached(key: string): Promise<Cached | undefined> {
        // allow(silent-catch): nothing kept, or something unreadable kept, is a rendering still to make.
        const text = await readFile(join(this.deps.dir, `${key}.json`), `utf8`).catch(() => undefined);
        if (text === undefined) {
            return undefined;
        }
        try {
            return CachedSchema.parse(JSON.parse(text));
        } catch {
            // allow(silent-catch): a kept rendering that does not parse is one to make again, over it.
            return undefined;
        }
    }

    #rendering(key: string, source: Source, format: Format): Promise<Outcome> {
        let running = this.#inFlight.get(key);
        if (running === undefined) {
            running = this.#render(key, source, format).finally(() => {
                // Out of flight before anyone hears of it, so the read a listener makes finds the kept text.
                this.#inFlight.delete(key);
                for (const listener of this.#landed) {
                    listener(source.abs);
                }
            });
            this.#inFlight.set(key, running);
        }
        return running;
    }

    // One reader's run over the file once its turn comes, its text folded as fileq folds a shadow's (neutralizeDoc), since a
    // document's text came from wherever the document did.
    async #render(key: string, source: Source, format: Format): Promise<Outcome> {
        if (this.#turns.full()) {
            return { kind: `failed`, reason: BUSY };
        }
        let cached: Cached;
        try {
            const reader = (await (fileq ??= loadFileq())).readers[format];
            const doc = await this.#turns.run(() => reader.derive(source.abs));
            cached = {
                deriver: await stampOf(format),
                derivedAt: new Date().toISOString(),
                notes: doc.notes.map((note) => neutralizeOutsideText(note)),
                markdown: neutralizeOutsideText(doc.markdown),
            };
            if (doc.title !== undefined) {
                cached.title = neutralizeOutsideText(doc.title);
            }
        } catch (error) {
            return { kind: `failed`, reason: `The ${format} reader couldn't read it: ${errorMessage(error).split(`\n`)[0] ?? ``}` };
        }
        await this.#keep(key, cached);
        return { kind: `derived`, cached };
    }

    // Written whole or not at all, so a reader never finds half a rendering.
    async #keep(key: string, cached: Cached): Promise<void> {
        const target = join(this.deps.dir, `${key}.json`);
        const temporary = `${target}.${randomBytes(4).toString(`hex`)}.tmp`;
        try {
            await mkdir(this.deps.dir, { recursive: true });
            await writeFile(temporary, JSON.stringify(cached));
            await rename(temporary, target);
        } catch (error) {
            // A rendering that cannot be kept is still the answer; the next ask renders it again.
            this.deps.log(`could not keep a document's text in ${this.deps.dir}: ${errorMessage(error)}`);
            await rm(temporary, { force: true });
        }
    }

    // The rendering, or why it is not here yet once the timeout passes; it goes on, and is kept when it lands.
    async #bounded(rendering: Promise<Outcome>): Promise<Outcome> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<Outcome>((resolve) => {
            timer = setTimeout(
                () => resolve({ kind: `failed`, reason: `Reading it is taking a while. Its text will be kept once it is ready; ask again then.` }),
                this.deps.timeoutMs ?? DERIVE_TIMEOUT_MS,
            );
        });
        try {
            return await Promise.race([rendering, late]);
        } finally {
            clearTimeout(timer);
        }
    }
}
