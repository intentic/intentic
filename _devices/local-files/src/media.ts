import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { json } from "@intentic/contract-serve";
import { webStream } from "@intentic/base/web-stream";
import { contentTypeFor, openFile } from "./files.js";
import type { Grant } from "./grants.js";

// A recording on this computer, streamed the way the daemon streams one from /work (its GET /workspace/media): in the
// byte ranges a <video> or <audio> asks for as it plays and seeks, so a film of any length costs a read buffer, never
// the whole file held in the window. Such an element asks for its ranges itself and cannot send the window's bearer, so
// the window first mints a ticket for the one file (`workspace.mediaTicket`, procedures.ts) and the element's address
// carries it. A ticket opens only that file, only for the grant that minted it, and only while that grant lasts
// (server.ts checks each request); it is unguessable, lives as long as a viewing session, and is held in memory only.

// As long as the daemon's: a playback paused for an afternoon still resumes.
const TICKET_TTL_MS = 8 * 60 * 60 * 1000;

export interface HeldTicket {
    readonly grant: Grant;
    // The file's real path when the ticket was minted; a request must still resolve to it.
    readonly abs: string;
    readonly expiresAt: number;
}

export class MediaTickets {
    readonly #held = new Map<string, HeldTicket>();

    constructor(private readonly now: () => number = Date.now) {}

    mint(grant: Grant, abs: string) {
        // A window closed mid-film leaves a ticket nobody redeems again.
        for (const [ticket, held] of this.#held) {
            if (held.expiresAt <= this.now()) {
                this.#held.delete(ticket);
            }
        }
        const ticket = randomBytes(32).toString(`base64url`);
        const expiresAt = this.now() + TICKET_TTL_MS;
        this.#held.set(ticket, { grant, abs, expiresAt });
        return { ticket, expiresAt };
    }

    // What a live ticket was minted for. Not used up: a playback redeems it for every range it reads.
    redeem(ticket: string): HeldTicket | undefined {
        const held = this.#held.get(ticket);
        if (held !== undefined && held.expiresAt <= this.now()) {
            this.#held.delete(ticket);
            return undefined;
        }
        return held;
    }

    // Drops every ticket a grant that ended minted.
    forget(grant: Grant): void {
        for (const [ticket, held] of this.#held) {
            if (held.grant === grant) {
                this.#held.delete(ticket);
            }
        }
    }
}

interface ByteRange {
    readonly start: number;
    // Inclusive, as Content-Range counts.
    readonly end: number;
    readonly partial: boolean;
}

// The one `bytes=` range asked of a file `size` long: the whole file when none is asked, or several are (no multipart
// answer), a suffix (`bytes=-500`, how a player reads an index at a file's end) as the last bytes, and `unsatisfiable`
// past the end. The daemon's own reading (parseByteRange, workspace-files-download.ts), since the element is the same.
export const rangeOf = (header: string | null, size: number): ByteRange | `unsatisfiable` => {
    const whole = { start: 0, end: Math.max(size - 1, 0), partial: false };
    const match = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (match === null) {
        return whole;
    }
    const [, from = ``, to = ``] = match;
    if (from === ``) {
        const length = Number(to);
        return to === `` || length <= 0 ? `unsatisfiable` : { start: Math.max(size - length, 0), end: size - 1, partial: true };
    }
    const start = Number(from);
    const end = to === `` ? size - 1 : Math.min(Number(to), size - 1);
    return start >= size || end < start ? `unsatisfiable` : { start, end, partial: true };
};

// The answer to one of an element's reads of `abs`: the range it asked for (206), or the whole file, typed so the element
// decodes it, and never cached, since a cached window of a file rewritten since is corrupt rather than stale.
// `download` asks the browser to save it under its own name instead.
export const mediaAnswer = async (abs: string, request: Request, url: URL): Promise<Response> => {
    const file = await openFile(abs);
    if (file === undefined) {
        return json({ error: `not found` }, 404);
    }
    const range = rangeOf(request.headers.get(`range`), file.size);
    if (range === `unsatisfiable`) {
        // The real size, or the element asks for the same window forever.
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${String(file.size)}` } });
    }
    const length = file.size === 0 ? 0 : range.end - range.start + 1;
    const headers = new Headers({
        "content-type": contentTypeFor(abs),
        "content-length": String(length),
        // Without it an element reads linearly instead of asking for ranges.
        "accept-ranges": `bytes`,
        "cache-control": `no-store`,
    });
    if (range.partial) {
        headers.set(`content-range`, `bytes ${String(range.start)}-${String(range.end)}/${String(file.size)}`);
    }
    if (url.searchParams.has(`download`)) {
        headers.set(`content-disposition`, `attachment; filename*=UTF-8''${encodeURIComponent(basename(abs))}`);
    }
    const status = range.partial ? 206 : 200;
    // An empty file has no range to open, and a HEAD wants the headers alone.
    if (length === 0 || request.method === `HEAD`) {
        return new Response(null, { status, headers });
    }
    return new Response(webStream<Uint8Array>(Readable.toWeb(createReadStream(abs, { start: range.start, end: range.end }))), { status, headers });
};
