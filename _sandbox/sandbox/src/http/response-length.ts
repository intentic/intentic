import type { OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from "node:http";

// A response whose body is shorter than the Content-Length it declared leaves the browser waiting for bytes that never
// come, while every log on this side reads status 200: compressResponses once kept an upstream length on a zstd body,
// and a page hung forever with nothing anywhere saying why. Node does not check the two against each other unless the
// server opts in, Hono hands the adapter a finished Response, and Node keeps no copy of headers given to writeHead, so
// the only place both numbers exist is the Node response itself, as it is written: what writeHead was told, and what
// write and end were given.

export interface LengthMismatch {
    readonly declared: number;
    readonly sent: number;
    readonly encoding: string | undefined;
    // The daemon ended its answer, but the connection closed before it was all flushed: the client gave up.
    readonly aborted: boolean;
}

type HeadArgument = string | OutgoingHttpHeaders | readonly OutgoingHttpHeader[] | undefined;

// What write and end are handed first: body bytes, or (end only) the callback when there is no body.
type Chunk = string | Uint8Array | (() => void);

const byteLengthOf = (chunk: Chunk | undefined): number => {
    if (chunk instanceof Uint8Array) {
        return chunk.byteLength;
    }
    return typeof chunk === "string" ? Buffer.byteLength(chunk) : 0;
};

// One header out of what writeHead was given: a record (what @hono/node-server passes) or a flat [name, value] list.
const headerOf = (args: readonly HeadArgument[], name: string): string | undefined => {
    for (const arg of args) {
        if (arg === undefined || typeof arg === "string") {
            continue;
        }
        const pairs: [string, OutgoingHttpHeader | undefined][] = Array.isArray(arg)
            ? arg.flatMap((key, index) => (index % 2 === 0 ? [[String(key), arg[index + 1]]] : []))
            : Object.entries(arg);
        const found = pairs.find(([key, value]) => key.toLowerCase() === name && value !== undefined);
        if (found !== undefined) {
            return String(found[1]);
        }
    }
    return undefined;
};

// Statuses that carry no body whatever their headers say.
const bodiless = (status: number): boolean => status === 204 || status === 304 || (status >= 100 && status < 200);

/**
 * Counts the body bytes `outgoing` is given and, once its connection closes, calls `onMismatch` if the daemon ended an
 * answer whose length differs from the one it declared. A client leaving before the daemon ended is ordinary (a closed
 * tab, a cancelled download) and reported as nothing. Does nothing without a Node response (`app.request` in tests, a
 * WebSocket upgrade) or for a HEAD request.
 */
export const watchResponseLength = (
    outgoing: ServerResponse | undefined,
    method: string,
    onMismatch: (mismatch: LengthMismatch) => void,
): void => {
    if (outgoing === undefined || method === "HEAD") {
        return;
    }
    let declared: number | undefined;
    let encoding: string | undefined;
    let sent = 0;
    let ended = false;
    // SAFETY: each original is called back with exactly the arguments it was given; these types are its overloads'
    // widest arguments, which is all a pass-through needs.
    const writeHead = outgoing.writeHead.bind(outgoing) as (status: number, ...rest: HeadArgument[]) => ServerResponse;
    // SAFETY: as above.
    const write = outgoing.write.bind(outgoing) as (chunk: Chunk, ...rest: never[]) => boolean;
    // SAFETY: as above.
    const end = outgoing.end.bind(outgoing) as (chunk?: Chunk, ...rest: never[]) => ServerResponse;
    // SAFETY: the replacement accepts what the overloads do and hands it to the original unchanged.
    outgoing.writeHead = ((status: number, ...rest: HeadArgument[]) => {
        const length = headerOf(rest, "content-length");
        declared = length === undefined || bodiless(status) ? undefined : Number(length);
        encoding = headerOf(rest, "content-encoding");
        return writeHead(status, ...rest);
    }) as ServerResponse["writeHead"];
    // SAFETY: as above.
    outgoing.write = ((chunk: Chunk, ...rest: never[]) => {
        sent += byteLengthOf(chunk);
        return write(chunk, ...rest);
    }) as ServerResponse["write"];
    // SAFETY: as above.
    outgoing.end = ((chunk?: Chunk, ...rest: never[]) => {
        sent += byteLengthOf(chunk);
        ended = true;
        return end(chunk, ...rest);
    }) as ServerResponse["end"];
    outgoing.once("close", () => {
        if (!ended || declared === undefined || !Number.isFinite(declared) || sent === declared) {
            return;
        }
        onMismatch({ declared, sent, encoding, aborted: !outgoing.writableFinished });
    });
};
