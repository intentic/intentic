import { packTar } from "./tarArchive";

// What the daemon's extractor reads back out of an archive this packs: each entry's path (a pax `path` record applies to
// the entry after it) and content.
const parseTar = (buf: Uint8Array): { path: string; content: string }[] => {
    const text = new TextDecoder();
    const cString = (offset: number, width: number): string => {
        const field = buf.subarray(offset, offset + width);
        const end = field.indexOf(0);
        return text.decode(end === -1 ? field : field.subarray(0, end));
    };
    const entries: { path: string; content: string }[] = [];
    let at = 0;
    let paxPath: string | undefined;
    while (at + 512 <= buf.length && buf.subarray(at, at + 512).some((byte) => byte !== 0)) {
        const type = String.fromCharCode(buf[at + 156] ?? 0);
        const name = cString(at, 100);
        const size = Number.parseInt(cString(at + 124, 12).trim() || `0`, 8);
        at += 512;
        const content = text.decode(buf.subarray(at, at + size));
        at += size + ((512 - (size % 512)) % 512);
        if (type === `x`) {
            paxPath = / path=(.*)\n/.exec(content)?.[1];
            continue;
        }
        entries.push({ path: paxPath ?? name, content });
        paxPath = undefined;
    }
    return entries;
};

const entry = (path: string, content: string): { path: string; file: File } => ({
    path,
    file: new File([content], path.split(`/`).at(-1) ?? path),
});

const LONG_PATH = `${`nested/`.repeat(20)}deep-file-with-a-fairly-long-name.txt`;

describe(`packTar`, () => {
    it(`frames short, nested, empty and over-100-byte paths so the extractor reads each back whole`, async () => {
        const { blob } = packTar([entry(`a.txt`, `hello`), entry(`dir/b.txt`, `world`), entry(`empty.txt`, ``), entry(LONG_PATH, `deep`)]);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        expect(parseTar(bytes)).toEqual([
            { path: `a.txt`, content: `hello` },
            { path: `dir/b.txt`, content: `world` },
            { path: `empty.txt`, content: `` },
            { path: LONG_PATH, content: `deep` },
        ]);
        // 512-aligned, and closed by the two zero blocks.
        expect([bytes.length % 512, bytes.subarray(-1024).every((byte) => byte === 0)]).toEqual([0, true]);
    });

    it(`says where each file's bytes begin, which is what maps the request's progress back onto files`, async () => {
        const { blob, starts } = packTar([entry(`a.txt`, `hello`), entry(LONG_PATH, `deep`), entry(`c.txt`, `sea`)]);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const at = (start: number, length: number): string => new TextDecoder().decode(bytes.subarray(start, start + length));
        expect([at(starts[0] ?? -1, 5), at(starts[1] ?? -1, 4), at(starts[2] ?? -1, 3)]).toEqual([`hello`, `deep`, `sea`]);
    });
});
