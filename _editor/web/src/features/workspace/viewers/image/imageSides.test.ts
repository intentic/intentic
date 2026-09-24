import { compareSides } from "./imageSides";

// The byte pass alone, which needs no decoder: equal sides answer `bytes` before anything is decoded, and a difference
// anywhere, the aligned body or the odd tail, is found.
const blob = (bytes: readonly number[]): Blob => new Blob([new Uint8Array(bytes)]);
const bytes = Array.from({ length: 4 * 1_024 + 3 }, (_, index) => (index * 7) & 255);

describe(`compareSides`, () => {
    it(`answers bytes for two sides holding the same file`, async () => {
        expect(await compareSides(blob(bytes), blob(bytes))).toEqual({ kind: `bytes` });
    });

    it(`finds a difference in the aligned body and in the odd tail alike`, async () => {
        const body = bytes.with(1_000, 255 - bytes[1_000]!);
        const tail = bytes.with(bytes.length - 1, 255 - bytes.at(-1)!);
        expect(await compareSides(blob(bytes), blob(body))).not.toEqual({ kind: `bytes` });
        expect(await compareSides(blob(bytes), blob(tail))).not.toEqual({ kind: `bytes` });
    });
});
