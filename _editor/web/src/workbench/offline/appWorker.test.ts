import { keepsOfflineCopy, type WorkerPlace } from "./appWorker";

// Which loads register the worker that keeps the editor's offline copy: the hosted editor wherever it is served from,
// never the dev server and never the desktop app's own bundle, which is a copy already.

const hosted: WorkerPlace = { protocol: `https:`, hostname: `app.intentic.dev`, secure: true, production: true, localWindow: false };

describe(`keepsOfflineCopy`, () => {
    it(`keeps one for the hosted editor, a self-hosted one, and a production build on this computer`, () => {
        expect([
            keepsOfflineCopy(hosted),
            keepsOfflineCopy({ ...hosted, hostname: `editor.example.net` }),
            keepsOfflineCopy({ ...hosted, protocol: `http:`, hostname: `localhost` }),
        ]).toEqual([true, true, true]);
    });

    it.each([
        [`the dev server`, { ...hosted, hostname: `localhost`, production: false }],
        [`the desktop app's bundle on Linux`, { ...hosted, protocol: `tauri:`, hostname: `localhost` }],
        [`the desktop app's bundle on Windows`, { ...hosted, protocol: `http:`, hostname: `tauri.localhost` }],
        [`the desktop app's bundle served over https`, { ...hosted, hostname: `tauri.localhost` }],
        [`a desktop window on a folder or this computer's sandboxes`, { ...hosted, localWindow: true }],
        [`a page that is not a secure context`, { ...hosted, protocol: `http:`, hostname: `192.168.1.20`, secure: false }],
    ])(`keeps none for %s`, (_where, place) => {
        expect(keepsOfflineCopy(place)).toBe(false);
    });
});
