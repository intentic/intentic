import { strToU8, unzipSync, zipSync } from "fflate";
import { createUnzip, type UnzipPort, type UnzipRequest, type UnzipResponse } from "./unzip";

// A worker stand-in that answers each request with `answer`, or crashes when that says so.
const port = (answer: (request: UnzipRequest) => UnzipResponse | `crash`): UnzipPort => {
    const listeners: { message?: (event: MessageEvent<UnzipResponse>) => void; error?: (event: ErrorEvent) => void } = {};
    return {
        postMessage: (request) =>
            queueMicrotask(() => {
                const reply = answer(request);
                if (reply === `crash`) {
                    listeners.error?.({ message: `worker died` } as ErrorEvent);
                } else {
                    listeners.message?.({ data: reply } as MessageEvent<UnzipResponse>);
                }
            }),
        addEventListener: ((type: `message` | `error`, listener: never) => {
            listeners[type] = listener;
        }) as UnzipPort[`addEventListener`],
        terminate: () => undefined,
    };
};

const archive = zipSync({ "a.txt": strToU8(`a`), "dir/b.txt": strToU8(`b`) });
const names = (parts: Record<string, Uint8Array>): string[] => Object.keys(parts).toSorted();

describe(`unzipParts`, () => {
    it(`hands back what the worker inflated`, async () => {
        const unzip = createUnzip(async () => port(({ id, bytes }) => ({ id, parts: unzipSync(bytes) })));
        expect(names(await unzip(archive))).toEqual([`a.txt`, `dir/b.txt`]);
    });

    it(`inflates on the page when no worker can run, or when one dies mid-call`, async () => {
        expect(names(await createUnzip(async () => undefined)(archive))).toEqual([`a.txt`, `dir/b.txt`]);
        expect(names(await createUnzip(async () => port(() => `crash`))(archive))).toEqual([`a.txt`, `dir/b.txt`]);
    });

    it(`refuses a file the worker could not read, rather than reading it again on the page`, async () => {
        let asked = 0;
        const unzip = createUnzip(async () =>
            port(({ id }) => {
                asked += 1;
                return { id, error: `invalid zip data` };
            }),
        );
        await expect(unzip(strToU8(`not a zip`))).rejects.toThrow(`invalid zip data`);
        expect(asked).toBe(1);
    });
});
