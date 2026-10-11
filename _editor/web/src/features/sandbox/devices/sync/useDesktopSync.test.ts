// What Enable sends the sandbox when it mints a sync pairing: the folder and takeover ride with the mint, and the
// sandbox refuses a folder that is empty.
const sandboxRequest = jest.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ token: `pair`, mode: `sync`, code: `ABCD1234`, expiresIn: 600 })));
jest.mock(`../../../../client/sandbox/sandboxClient`, () => ({ sandboxRequest: (path: string, init?: RequestInit) => sandboxRequest(path, init) }));

import { mintSyncPairing } from "./useDesktopSync";

const sentBody = (): unknown => JSON.parse(String(sandboxRequest.mock.calls.at(-1)?.[1]?.body));

beforeEach(() => sandboxRequest.mockClear());

it(`sends the folder the person chose`, async () => {
    await mintSyncPairing(`sync`, { syncDir: `~/intentic/web`, takeover: true });
    expect(sentBody()).toEqual({ syncDir: `~/intentic/web`, takeover: true });
});

// Clearing the Local folder field means the device's default folder, as it did before the folder was sent at all.
it(`leaves a blank folder out instead of sending one the sandbox refuses`, async () => {
    await mintSyncPairing(`sync`, { syncDir: ``, takeover: false });
    expect(sentBody()).toEqual({ takeover: false });
    await mintSyncPairing(`sync`, { syncDir: `   ` });
    expect(sentBody()).toEqual({});
});

it(`sends no folder for a ports-only pairing`, async () => {
    await mintSyncPairing(`mirror`, { syncDir: `~/intentic/web` });
    expect(sandboxRequest.mock.calls.at(-1)?.[0]).toBe(`/system/sync/pair?mode=mirror`);
    expect(sentBody()).toEqual({});
});
