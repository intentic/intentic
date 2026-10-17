import { Duplex, pipeline, Readable, Transform } from "node:stream";
import { constants, crc32, createDeflateRaw } from "node:zlib";
import { isPackedName } from "@intentic/sandbox-contract/text/packed-formats";

// The bundle's gzip, its level following what is being packed into it. Most of /history is already compressed (the
// zstd transcript records and blobs, git's packed and loose objects), and deflate spends ten times as long failing to
// shrink those bytes as storing them costs: 69 against 613 MB/s on a sandbox's history, for 3% of its size. So they go
// in stored (level 0), and the workspace's text, the database snapshot and the manifest at level 6. Still one standard
// gzip member, so every daemon reads the bundle as it always has, older ones included.
//
// The gzip framing (RFC 1952) is written here around a raw deflate stream, because Node changes the level of a raw
// deflate stream but silently ignores `params()` on a gzip one.

const DEFLATED = 6;
const STORED = 0;

// ID1 ID2, deflate, no flags, no mtime, no extra flags, OS unknown.
const HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]);

// git's own objects, zlib-compressed by git: a pack, or a loose object under objects/<2 hex>/<38+ hex>.
const GIT_OBJECT = /(^|\/)objects\/(pack\/[^/]+\.pack|[0-9a-f]{2}\/[0-9a-f]{38,62})$/u;

export const alreadyCompressed = (name: string): boolean => isPackedName(name) || GIT_OBJECT.test(name);

export interface LevelledGzip {
    // Written with the tar, read as the .tar.gz.
    readonly gzip: Duplex;
    // Awaited before a file is packed. A change of level flushes what is pending first, so it takes effect at about
    // that file's start; a few bytes of a neighbour at the other level cost nothing.
    readonly packing: (name: string) => Promise<void>;
}

export const levelledGzip = (): LevelledGzip => {
    const deflate = createDeflateRaw({ level: DEFLATED });
    let crc = 0;
    let size = 0;
    // The trailer's two figures, over the bytes as they went in: their CRC-32 and their length modulo 2^32.
    const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
            crc = crc32(chunk, crc);
            size = (size + chunk.byteLength) % 2 ** 32;
            done(null, chunk);
        },
    });
    // pipeline, so a failure on either side destroys both and reaches the reader.
    pipeline(counted, deflate, () => undefined);
    const framed = Readable.from(
        (async function* () {
            yield HEADER;
            yield* deflate;
            const trailer = Buffer.alloc(8);
            trailer.writeUInt32LE(crc >>> 0, 0);
            trailer.writeUInt32LE(size, 4);
            yield trailer;
        })(),
    );
    let level = DEFLATED;
    return {
        gzip: Duplex.from({ writable: counted, readable: framed }),
        packing: async (name) => {
            const next = alreadyCompressed(name) ? STORED : DEFLATED;
            if (next === level) {
                return;
            }
            level = next;
            await new Promise<void>((resolve) => deflate.params(next, constants.Z_DEFAULT_STRATEGY, () => resolve()));
        },
    };
};
