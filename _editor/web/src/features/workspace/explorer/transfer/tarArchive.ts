// Packs dropped files into one tar archive so a directory drop uploads many files per request
// (/workspace/upload-archive extracts it). USTAR format; paths over 100 bytes get a pax extended header.

export interface TarEntry {
    readonly file: File;
    readonly path: string;
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
const header = (name: string, size: number, mtimeSec: number, typeflag: string): Uint8Array<ArrayBuffer> => {
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
const paxRecord = (key: string, value: string): Uint8Array<ArrayBuffer> => {
    const bodyBytes = enc.encode(` ${key}=${value}\n`).length;
    let total = bodyBytes + 1;
    while (String(total).length + bodyBytes !== total) {
        total = String(total).length + bodyBytes;
    }
    return enc.encode(`${total} ${key}=${value}\n`);
};

const padding = (size: number): number => (512 - (size % 512)) % 512;

export interface TarArchive {
    readonly blob: Blob;
    // Where each entry's content begins in `blob`, in entry order: what turns the request's byte progress back into
    // which file is going and how much of it has gone.
    readonly starts: readonly number[];
}

const ZEROS = new Uint8Array(1024);

// The archive as a Blob composed of the files themselves: the browser reads each file from disk as the request sends
// it, so nothing is copied into memory, and with its length known up front it goes as one XMLHttpRequest on any
// transport (a streamed fetch body needs HTTP/2, which a local sandbox's plain loopback address lacks). A file that
// changed on disk since the drop fails the browser's read, and so the request, rather than landing short or padded.
export const packTar = (entries: readonly TarEntry[]): TarArchive => {
    const parts: BlobPart[] = [];
    const starts: number[] = [];
    let at = 0;
    const push = (part: BlobPart, size: number): void => {
        parts.push(part);
        at += size;
    };
    for (const { file, path } of entries) {
        const mtimeSec = Math.floor(file.lastModified / 1000);
        // Long paths ride in a pax extended header (tar-stream applies its `path` over the ustar name below).
        if (enc.encode(path).length > 100) {
            const record = paxRecord("path", path);
            push(header("PaxHeader", record.length, mtimeSec, "x"), 512);
            push(record, record.length);
            push(ZEROS.subarray(0, padding(record.length)), padding(record.length));
        }
        push(header(path, file.size, mtimeSec, "0"), 512);
        starts.push(at);
        push(file, file.size);
        push(ZEROS.subarray(0, padding(file.size)), padding(file.size));
    }
    // Two zero blocks mark end-of-archive.
    push(ZEROS, ZEROS.length);
    return { blob: new Blob(parts), starts };
};
