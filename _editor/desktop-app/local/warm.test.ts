import type { LocalFace } from "@intentic/web/local";
import { editorChunk, FACE_EVENT, type FaceHost, faceArrives } from "./warm";

// The face the app hands a waiting window, set on the window first and then announced (src-tauri windows.rs).
const FACE: LocalFace = { daemonUrl: `http://127.0.0.1:47148`, token: `window-bearer`, id: `f3a9c2`, name: `Taxes 2026`, path: `/home/ada/Taxes 2026` };

const waitingWindow = (): EventTarget & FaceHost => Object.assign(new EventTarget(), { __INTENTIC_LOCAL__: undefined });

// Whether a promise has settled by now, without waiting on it.
const settled = async <Value>(promise: Promise<Value>): Promise<Value | `waiting`> => await Promise.race([promise, Promise.resolve(`waiting` as const)]);

describe(`a window waiting for its face`, () => {
    it(`boots on the face the app set and then announced`, async () => {
        const host = waitingWindow();
        const arriving = faceArrives(host);
        expect(await settled(arriving)).toBe(`waiting`);
        host.__INTENTIC_LOCAL__ = FACE;
        host.dispatchEvent(new CustomEvent(FACE_EVENT));
        expect(await arriving).toBe(FACE);
    });

    it(`keeps waiting through an announcement with no face behind it`, async () => {
        const host = waitingWindow();
        const arriving = faceArrives(host);
        host.dispatchEvent(new CustomEvent(FACE_EVENT));
        expect(await settled(arriving)).toBe(`waiting`);
        host.__INTENTIC_LOCAL__ = FACE;
        host.dispatchEvent(new CustomEvent(FACE_EVENT));
        expect(await arriving).toBe(FACE);
    });

    it(`stops listening once it has its face`, async () => {
        const host = waitingWindow();
        const removed = jest.spyOn(host, `removeEventListener`);
        const arriving = faceArrives(host);
        host.__INTENTIC_LOCAL__ = FACE;
        host.dispatchEvent(new CustomEvent(FACE_EVENT));
        await arriving;
        expect(removed.mock.calls.map(([type]) => type)).toEqual([FACE_EVENT]);
    });
});

describe(`the editor's chunk, named without running it`, () => {
    // The page's entry, where a built app serves it; the chunks sit beside it.
    const ENTRY = `http://tauri.localhost/files/assets/local-bD5z1KXv.js`;

    it(`reads the address off the loader as the build writes it: behind vite's preload helper, in a template literal`, () => {
        expect(editorChunk("async()=>{await e(()=>import(`./main-BV_D6EMR.js`),[])}", ENTRY)).toBe(`http://tauri.localhost/files/assets/main-BV_D6EMR.js`);
    });

    it(`reads either other quote, and a rooted or a parent path`, () => {
        expect(editorChunk(`() => import("./main-a1.js")`, ENTRY)).toBe(`http://tauri.localhost/files/assets/main-a1.js`);
        expect(editorChunk(`() => import('../chunks/main-b2.js')`, ENTRY)).toBe(`http://tauri.localhost/files/chunks/main-b2.js`);
        expect(editorChunk(`() => import("/files/assets/main-c3.js")`, ENTRY)).toBe(`http://tauri.localhost/files/assets/main-c3.js`);
    });

    it(`names nothing when the source holds no import it can follow`, () => {
        expect(editorChunk(`async () => { await load(); }`, ENTRY)).toBeUndefined();
        // A bare name is a module the build never resolved: there is no file behind it.
        expect(editorChunk("() => import(`@intentic/web/main`)", ENTRY)).toBeUndefined();
        // Built from a variable, it has no address until it runs.
        expect(editorChunk("() => import(`./${name}.js`)", ENTRY)).toBeUndefined();
    });
});
