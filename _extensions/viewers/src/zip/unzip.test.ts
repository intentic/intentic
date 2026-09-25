import { strToU8, type Unzipped, unzipSync, zipSync } from "fflate";
import { fakeWorkerPort as port } from "../testing";
import { createUnzip } from "./unzip";

const archive = zipSync({ "a.txt": strToU8(`a`), "dir/b.txt": strToU8(`b`) });
const names = (parts: Record<string, Uint8Array>): string[] => Object.keys(parts).toSorted();

describe(`unzipParts`, () => {
    it(`hands back what the worker inflated`, async () => {
        const unzip = createUnzip(async () => port<Uint8Array, Unzipped>(({ id, args }) => ({ id, result: unzipSync(args) })));
        expect(names(await unzip(archive))).toEqual([`a.txt`, `dir/b.txt`]);
    });

    it(`inflates on the page when no worker can run, or when one dies mid-call`, async () => {
        expect(names(await createUnzip(async () => undefined)(archive))).toEqual([`a.txt`, `dir/b.txt`]);
        expect(names(await createUnzip(async () => port<Uint8Array, Unzipped>(() => `crash`))(archive))).toEqual([`a.txt`, `dir/b.txt`]);
    });

    it(`refuses a file the worker could not read, rather than reading it again on the page`, async () => {
        let asked = 0;
        const unzip = createUnzip(async () =>
            port<Uint8Array, Unzipped>(({ id }) => {
                asked += 1;
                return { id, error: `invalid zip data` };
            }),
        );
        await expect(unzip(strToU8(`not a zip`))).rejects.toThrow(`invalid zip data`);
        expect(asked).toBe(1);
    });
});
