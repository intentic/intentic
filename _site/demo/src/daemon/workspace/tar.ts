// The tar a folder drop sends (the editor's tarArchive.ts writes USTAR, with a pax header for a path over 100 bytes),
// read entry by entry the way the daemon's extractor walks it.

const BLOCK = 512;

export interface TarEntry {
    readonly path: string;
    readonly type: "file" | "dir";
    readonly bytes: Uint8Array<ArrayBuffer>;
}

const decoder = new TextDecoder();

const field = (block: Uint8Array, offset: number, length: number): string => {
    const raw = block.subarray(offset, offset + length);
    const end = raw.indexOf(0);
    return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
};

const octal = (block: Uint8Array, offset: number, length: number): number => Number.parseInt(field(block, offset, length).trim() || `0`, 8);

// A pax record set is `<length> <key>=<value>\n` repeated; only the path matters here.
const paxPath = (body: Uint8Array): string | undefined => {
    for (const record of decoder.decode(body).split(`\n`)) {
        const match = /^\d+ path=(.*)$/u.exec(record);
        if (match?.[1] !== undefined) {
            return match[1];
        }
    }
    return undefined;
};

/** Every entry of a tar, in order; a path that climbs out or starts at the root is refused like the daemon's 400. */
export const readTar = (archive: Uint8Array<ArrayBuffer>): TarEntry[] => {
    const entries: TarEntry[] = [];
    let longPath: string | undefined;
    for (let offset = 0; offset + BLOCK <= archive.length; ) {
        const header = archive.subarray(offset, offset + BLOCK);
        if (header.every((byte) => byte === 0)) {
            break;
        }
        const size = octal(header, 124, 12);
        const flag = String.fromCharCode(header[156] ?? 0);
        const body = archive.slice(offset + BLOCK, offset + BLOCK + size);
        offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
        if (flag === `x`) {
            longPath = paxPath(body);
            continue;
        }
        const prefix = field(header, 345, 155);
        const name = longPath ?? (prefix === `` ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`);
        longPath = undefined;
        const path = name.replace(/\/+$/u, ``);
        if (path.startsWith(`/`) || path.split(`/`).includes(`..`)) {
            throw new Error(`invalid path`);
        }
        if (flag === `5`) {
            entries.push({ path, type: `dir`, bytes: body });
        } else if (flag === `0` || flag === `\0`) {
            entries.push({ path, type: `file`, bytes: body });
        }
    }
    return entries;
};
