// Streams dropped files into one tar archive (ReadableStream) so a directory drop uploads in a single request
// (/workspace/upload-archive extracts it). Pull-based, one file chunk at a time, so a multi-GB tree is never buffered
// in memory. USTAR format; paths over 100 bytes get a pax extended header.

export interface TarEntry {
    readonly file: File;
    readonly path: string;
}

export interface PackHooks {
    // Fired as each entry begins streaming; drives the "currently landing" line.
    readonly onFileStart?: (path: string) => void;
    // Fired per content chunk with the byte delta, drives the aggregate byte progress + throughput.
    readonly onBytes?: (delta: number) => void;
}

const enc = new TextEncoder();

// Copy a UTF-8 string into a fixed-width header field (truncating at the byte boundary; the rest stays zero).
const writeStr = (block: Uint8Array, value: string, offset: number, width: number): void => {
    const bytes = enc.encode(value);
    block.set(bytes.subarray(0, width), offset);
};

// Numeric header field: octal, left-padded with '0', NUL-terminated. Falls back to GNU base-256 (high bit set,
// big-endian) past ~8 GB, where octal can't represent the size.
const writeNumeric = (block: Uint8Array, value: number, offset: number, width: number): void => {
    if (value < 8 ** (width - 1)) {
        const octal = value.toString(8).padStart(width - 1, "0");
        for (let i = 0; i < width - 1; i++) {
            block[offset + i] = octal.charCodeAt(i);
        }
        return;
    }
    block[offset] = 0x80;
    let remaining = value;
    for (let i = width - 1; i >= 1; i--) {
        block[offset + i] = remaining % 256;
        remaining = Math.floor(remaining / 256);
    }
};

// One 512-byte USTAR header block with a computed checksum. typeflag: "0" file, "x" pax extended header.
const header = (name: string, size: number, mtimeSec: number, typeflag: string): Uint8Array => {
    const block = new Uint8Array(512);
    writeStr(block, name, 0, 100);
    writeNumeric(block, 0o644, 100, 8); // mode
    writeNumeric(block, 0, 108, 8); // uid
    writeNumeric(block, 0, 116, 8); // gid
    writeNumeric(block, size, 124, 12);
    writeNumeric(block, mtimeSec, 136, 12);
    block[156] = typeflag.charCodeAt(0);
    writeStr(block, "ustar", 257, 6); // magic "ustar\0"
    block[263] = 0x30; // version "00"
    block[264] = 0x30;
    // Checksum is computed with the 8 checksum bytes treated as spaces, then written back as octal + NUL + space.
    for (let i = 148; i < 156; i++) {
        block[i] = 0x20;
    }
    let sum = 0;
    for (const byte of block) {
        sum += byte;
    }
    const octal = sum.toString(8).padStart(6, "0");
    for (let i = 0; i < 6; i++) {
        block[148 + i] = octal.charCodeAt(i);
    }
    block[154] = 0;
    block[155] = 0x20;
    return block;
};

// A pax extended-header record: "<len> key=value\n", where <len> counts its own digits (solved iteratively).
const paxRecord = (key: string, value: string): Uint8Array => {
    const bodyBytes = enc.encode(` ${key}=${value}\n`).length;
    let total = bodyBytes + 1;
    while (String(total).length + bodyBytes !== total) {
        total = String(total).length + bodyBytes;
    }
    return enc.encode(`${total} ${key}=${value}\n`);
};

const padding = (size: number): number => (512 - (size % 512)) % 512;

async function* tarChunks(entries: readonly TarEntry[], hooks: PackHooks): AsyncGenerator<Uint8Array> {
    for (const { file, path } of entries) {
        hooks.onFileStart?.(path);
        const mtimeSec = Math.floor(file.lastModified / 1000);
        // Long paths ride in a pax extended header (tar-stream applies its `path` over the ustar name below).
        if (enc.encode(path).length > 100) {
            const record = paxRecord("path", path);
            yield header("PaxHeader", record.length, mtimeSec, "x");
            yield record;
            const pad = padding(record.length);
            if (pad > 0) {
                yield new Uint8Array(pad);
            }
        }
        // file.size is captured at scan time; if the file changed by upload time, the body is truncated or zero-filled
        // to match exactly, keeping 512-byte framing aligned.
        yield header(path, file.size, mtimeSec, "0");
        let sent = 0;
        try {
            const reader = file.stream().getReader();
            for (;;) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                const slice = sent + value.byteLength > file.size ? value.subarray(0, file.size - sent) : value;
                if (slice.byteLength === 0) {
                    break;
                }
                sent += slice.byteLength;
                hooks.onBytes?.(slice.byteLength);
                yield slice;
            }
        } catch (error) {
            console.warn(`Padding ${path}: read failed mid-upload`, error);
        }
        const shortfall = file.size - sent;
        if (shortfall > 0) {
            yield new Uint8Array(shortfall);
        }
        const pad = padding(file.size);
        if (pad > 0) {
            yield new Uint8Array(pad);
        }
    }
    // Two zero blocks mark end-of-archive.
    yield new Uint8Array(1024);
}

export const packTar = (entries: readonly TarEntry[], hooks: PackHooks = {}): ReadableStream<Uint8Array> => {
    const gen = tarChunks(entries, hooks);
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { value, done } = await gen.next();
            if (done) {
                controller.close();
                return;
            }
            controller.enqueue(value);
        },
        async cancel() {
            await gen.return(undefined);
        },
    });
};
