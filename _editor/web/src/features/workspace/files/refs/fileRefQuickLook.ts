import type { WorkspaceFile } from "@intentic/sandbox-contract";
import { resolveFile } from "../../explorer/fileType";

// What a hover over a file reference shows: the lines around the one it names, or the top of the file when it names
// none, or why there is nothing to show (gone, a folder, bytes). Pure: the reads arrive through PeekIo, so the
// component (FileRefPeek.vue) owns only the pointer and the drawing.

// Lines above and below the named one. Twelve rows in all, kept at twelve near either end of the file (the window
// slides rather than shrinks), so the card is one height whichever line it opens on.
export const PEEK_ABOVE = 3;
export const PEEK_BELOW = 8;
export const PEEK_SPAN = PEEK_ABOVE + 1 + PEEK_BELOW;

// Lines read ahead of the window only to colour it: a comment or string opened above it still reads as one.
export const PEEK_LEAD = 30;

// Characters of one line drawn; a minified line is cut, since a glance can't use the rest and colouring it would cost a
// long task.
export const PEEK_LINE_CHARS = 240;

// The first read: most source files whole in one cheap round trip. A line past it asks again, each read as long as all
// the reads before it, while the total stays within PEEK_REACH; a line beyond that is left to opening the file.
export const PEEK_FIRST_BYTES = 64 * 1024;
export const PEEK_REACH_BYTES = 2 * 1024 * 1024;

// Names a folder's card lists; the count says the rest.
export const PEEK_FOLDER_NAMES = 6;

// What a peek has learned about one path. `text` is the file from its first byte up to `bytes`, whole once `bytes`
// reaches `size`; `done` stops further reads (whole, out of reach, or the file changed under the read).
export type PeekFile =
    | { readonly kind: "text"; readonly path: string; readonly text: string; readonly bytes: number; readonly size: number; readonly done: boolean }
    | { readonly kind: "empty"; readonly path: string }
    | { readonly kind: "binary"; readonly path: string; readonly size: number }
    | { readonly kind: "folder"; readonly path: string; readonly names: readonly string[]; readonly count: number }
    | { readonly kind: "missing"; readonly path: string };

// What the card draws. `lines` starts at line `first`; `target` is the marked one; `total` is known only once the file
// was read whole; `past` means the named line is after the file's end, so the card shows its last lines instead.
export type PeekView =
    | {
          readonly kind: "lines";
          readonly path: string;
          readonly first: number;
          readonly lines: readonly string[];
          readonly lead: readonly string[];
          readonly target: number | undefined;
          readonly total: number | undefined;
          readonly past: boolean;
      }
    | { readonly kind: "beyond"; readonly path: string; readonly line: number }
    | Exclude<PeekFile, { readonly kind: "text" }>;

// The daemon calls a peek makes, injected so the reading rules are tested without one.
export interface PeekIo {
    // The workspace path a written reference means (often only its tail); undefined leaves it as written.
    readonly resolve: (path: string) => Promise<string | undefined>;
    readonly read: (path: string, offset: number, limit: number) => Promise<WorkspaceFile>;
    // What a folder holds; undefined or none at all reads as nothing there, since a missing path lists empty too.
    readonly list: (path: string) => Promise<{ readonly names: readonly string[]; readonly count: number } | undefined>;
}

// A run of lines, 1-based and inclusive at both ends; `last` below `first` is no lines.
export interface PeekRange {
    readonly first: number;
    readonly last: number;
}

// The rows around `line` in a file of `count` lines; no line means the top of the file. A line past the end is clamped
// to it, so the caller can still show the file's last lines.
export const peekRange = (line: number | undefined, count: number): PeekRange => {
    if (count <= 0) {
        return { first: 1, last: 0 };
    }
    const at = line === undefined ? 1 : Math.min(Math.max(line, 1), count);
    const first = line === undefined ? 1 : Math.max(1, Math.min(at - PEEK_ABOVE, count - PEEK_SPAN + 1));
    return { first, last: Math.min(count, first + PEEK_SPAN - 1) };
};

// A file's lines as read so far: the empty string after a final newline is not a line, and a CRLF file draws no `\r`.
export const quickLookLines = (text: string): string[] => {
    if (text === ``) {
        return [];
    }
    const lines = text.split(`\n`);
    if (lines.at(-1) === ``) {
        lines.pop();
    }
    return lines.map((line) => (line.endsWith(`\r`) ? line.slice(0, -1) : line));
};

const clip = (line: string): string => (line.length > PEEK_LINE_CHARS ? `${line.slice(0, PEEK_LINE_CHARS)}…` : line);

// Whether the lines read so far fall short of the window `line` needs (the top of the file's, for no line), with more
// of the file left to read.
export const peekWantsMore = (file: PeekFile, line: number | undefined): boolean =>
    file.kind === `text` && !file.done && quickLookLines(file.text).length < (line === undefined ? PEEK_SPAN : line + PEEK_BELOW);

export const peekView = (file: PeekFile, line: number | undefined): PeekView => {
    if (file.kind !== `text`) {
        return file;
    }
    const lines = quickLookLines(file.text);
    const whole = file.bytes >= file.size;
    if (line !== undefined && line > lines.length && !whole) {
        return { kind: `beyond`, path: file.path, line };
    }
    const past = line !== undefined && line > lines.length;
    const { first, last } = peekRange(line, lines.length);
    return {
        kind: `lines`,
        path: file.path,
        first,
        lines: lines.slice(first - 1, last).map(clip),
        lead: lines.slice(Math.max(0, first - 1 - PEEK_LEAD), first - 1).map(clip),
        target: past ? undefined : line,
        total: whole ? lines.length : undefined,
        past,
    };
};

// A path whose name says bytes (a picture, an archive) is asked only whether it is there and how big, not for its
// contents.
const bytesByName = (path: string): boolean => resolveFile(path, undefined).mode === `binary`;

const fromWindow = (path: string, window: Extract<WorkspaceFile, { present: true }>): PeekFile => {
    if (window.size === 0) {
        return { kind: `empty`, path };
    }
    // NUL is the tell for bytes under a text-looking name, the same one the home's quick look reads.
    if (bytesByName(path) || window.lossy === true || window.content.includes(`\0`)) {
        return { kind: `binary`, path, size: window.size };
    }
    const bytes = window.offset + window.bytes;
    return { kind: `text`, path, text: window.content, bytes, size: window.size, done: bytes >= window.size };
};

// Appends the next window to what was read. The daemon skips a partial line at a window's start, which only happens
// after a single line longer than the last window: that line is ended where it was cut, so the numbering below it
// holds. A read that moved nothing, or found the file gone, stops the reading rather than looping.
export const extendPeek = (file: Extract<PeekFile, { kind: "text" }>, window: WorkspaceFile): PeekFile => {
    if (!window.present || window.bytes === 0 || window.offset < file.bytes) {
        return { ...file, done: true };
    }
    const joint = window.offset > file.bytes && !file.text.endsWith(`\n`) ? `\n` : ``;
    const bytes = window.offset + window.bytes;
    return {
        ...file,
        text: `${file.text}${joint}${window.content}`,
        bytes,
        size: window.size,
        done: bytes >= window.size || bytes * 2 > PEEK_REACH_BYTES,
    };
};

const firstRead = async (io: PeekIo, written: string): Promise<PeekFile> => {
    const path = (await io.resolve(written)) ?? written;
    const window = await io.read(path, 0, bytesByName(path) ? 1 : PEEK_FIRST_BYTES);
    if (window.present) {
        return fromWindow(path, window);
    }
    // A folder reads as absent (the daemon answers a directory like a missing file), so a listing tells the two apart.
    const listed = await io.list(path).catch((cause: unknown) => {
        console.warn("Could not list a quick look target", cause);
        return undefined;
    });
    return listed === undefined || listed.count === 0
        ? { kind: `missing`, path }
        : { kind: `folder`, path, names: listed.names.slice(0, PEEK_FOLDER_NAMES), count: listed.count };
};

// Reads what `line` needs, starting from what an earlier hover already `held` for the same reference. A refused or
// unreachable read throws; nothing here is kept on failure.
export const readPeek = async (io: PeekIo, written: string, line: number | undefined, held?: PeekFile): Promise<PeekFile> => {
    let file = held ?? (await firstRead(io, written));
    while (file.kind === `text` && peekWantsMore(file, line)) {
        file = extendPeek(file, await io.read(file.path, file.bytes, Math.max(PEEK_FIRST_BYTES, file.bytes)));
    }
    return file;
};

// How much of the byte budget a held answer costs: its text, or a token amount for an answer with none.
const weightOf = (file: PeekFile): number => (file.kind === `text` ? file.text.length : 64);

export interface PeekCache {
    // The answer held for `key` if it is still fresh, synchronously, so a second hover draws at once.
    readonly peek: (key: string) => PeekFile | undefined;
    // The answer for `key` that `enough` accepts: the fresh one held, the read already under way, or a new read handed
    // whatever was held. A read that fails is not remembered, so the next hover tries again.
    readonly load: (key: string, read: (held: PeekFile | undefined) => Promise<PeekFile>, enough: (file: PeekFile) => boolean) => Promise<PeekFile>;
}

export interface PeekCacheOptions {
    // How long an answer stands before the file is read again: the agent the chat is watching may be editing it.
    readonly freshFor: number;
    // The characters of file text held at once, across every path; the least recently shown goes first.
    readonly budget: number;
    readonly now?: () => number;
}

// One per surface: every reference in a transcript shares it, and it goes with the view.
export const createPeekCache = ({ freshFor, budget, now = Date.now }: PeekCacheOptions): PeekCache => {
    const held = new Map<string, { readonly at: number; readonly file: PeekFile }>();
    const reading = new Map<string, Promise<PeekFile>>();

    const peek = (key: string): PeekFile | undefined => {
        const entry = held.get(key);
        if (entry === undefined) {
            return undefined;
        }
        if (now() - entry.at > freshFor) {
            held.delete(key);
            return undefined;
        }
        // Re-inserted so the Map's order is the order of use, oldest first.
        held.delete(key);
        held.set(key, entry);
        return entry.file;
    };

    const keep = (key: string, file: PeekFile): void => {
        held.delete(key);
        held.set(key, { at: now(), file });
        let weight = 0;
        for (const entry of held.values()) {
            weight += weightOf(entry.file);
        }
        for (const [oldest, entry] of held) {
            if (weight <= budget || oldest === key) {
                break;
            }
            weight -= weightOf(entry.file);
            held.delete(oldest);
        }
    };

    const load = (key: string, read: (held: PeekFile | undefined) => Promise<PeekFile>, enough: (file: PeekFile) => boolean): Promise<PeekFile> => {
        const fresh = peek(key);
        if (fresh !== undefined && enough(fresh)) {
            return Promise.resolve(fresh);
        }
        const underway = reading.get(key);
        if (underway !== undefined) {
            // The read under way may be for another line of the same file; if it falls short, this one carries on from it.
            return underway.then((file) => (enough(file) ? file : load(key, read, enough)));
        }
        // Kept before the read stops counting as under way, so a hover chained on it finds the answer held.
        const started = read(fresh)
            .then((file) => {
                keep(key, file);
                return file;
            })
            .finally(() => reading.delete(key));
        reading.set(key, started);
        return started;
    };

    return { peek, load };
};

// The cache key: the reference as written, in the tree it was written about. An isolated conversation's `src/a.ts` is
// another file than the shared tree's.
export const peekKey = (path: string, agent: string | undefined): string => `${agent ?? ``}\u0000${path}`;
