import { packTar } from "./tarStream";

// A file's bytes as the upload reads them; `source` stands in for a disk that changes or fails under the read.
const fileOf = (name: string, size: number, source: (controller: ReadableStreamDefaultController<Uint8Array>) => void): File =>
    Object.assign(new File([new Uint8Array(size)], name), { stream: () => new ReadableStream<Uint8Array>({ start: source }) });

const drain = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
    const parts: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        parts.push(value);
    }
    const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
        whole.set(part, at);
        at += part.byteLength;
    }
    return whole;
};

describe(`packTar`, () => {
    it(`frames a readable file as header, padded body, and the two end blocks`, async () => {
        const file = fileOf(`a.txt`, 5, (controller) => {
            controller.enqueue(new TextEncoder().encode(`hello`));
            controller.close();
        });
        const archive = await drain(packTar([{ file, path: `a.txt` }]));
        expect({ length: archive.byteLength, body: new TextDecoder().decode(archive.subarray(512, 517)) }).toEqual({ length: 2048, body: `hello` });
    });

    it(`errors the archive when a file fails mid-read, instead of landing it zero-filled`, async () => {
        const unreadable: string[] = [];
        const file = fileOf(`a.txt`, 6, (controller) => {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.error(new Error(`NotReadableError`));
        });
        const packed = drain(packTar([{ file, path: `a.txt` }], { onUnreadable: (path) => unreadable.push(path) }));
        await expect(packed).rejects.toThrow(`a.txt could not be read in full mid-upload`);
        expect(unreadable).toEqual([`a.txt`]);
    });

    it(`errors the archive when a file shrank below the size its header promised`, async () => {
        const file = fileOf(`b.txt`, 6, (controller) => {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.close();
        });
        await expect(drain(packTar([{ file, path: `b.txt` }]))).rejects.toThrow(`b.txt could not be read in full mid-upload`);
    });
});
