import type { IntenticApi } from "@intentic/extension-api";
import { unstubbed } from "@intentic/testing";
import { originalOf, restoreOriginal } from "./docs.js";
import { bindHost } from "./host.js";

// The viewer's two calls about the original a local window's backend keeps: what is asked, and what an answer reads as.
// A sandbox's backend has no such route, and its 404 must read as "nothing kept", never as a failure.

interface Asked {
    readonly path: string;
    readonly method: string;
    readonly body: unknown;
}

const asked: Asked[] = [];
let answer = (): Response => new Response(null, { status: 404 });

beforeEach(() => {
    asked.length = 0;
    bindHost(
        unstubbed<IntenticApi>(`host`, {
            backend: unstubbed<IntenticApi[`backend`]>(`host.backend`, {
                request: async (path, init) => {
                    asked.push({ path, method: init?.method ?? `GET`, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
                    return answer();
                },
            }),
        }),
    );
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": `application/json` } });

describe(`the kept original`, () => {
    it(`is asked about through the extension's own backend, the path as a query`, async () => {
        answer = () => json({ kept: false });
        await originalOf(`reports/Q3 plan.docx`);
        expect(asked).toEqual([{ path: `original?path=reports%2FQ3+plan.docx`, method: `GET`, body: undefined }]);
    });

    it(`reads a kept original with when it was kept, in epoch milliseconds whichever way the backend wrote it`, async () => {
        answer = () => json({ kept: true, keptAt: `2026-09-28T10:00:00.000Z` });
        expect(await originalOf(`brief.docx`)).toEqual({ keptAt: Date.parse(`2026-09-28T10:00:00.000Z`) });
        answer = () => json({ kept: true, keptAt: 1_790_000_000_000 });
        expect(await originalOf(`brief.docx`)).toEqual({ keptAt: 1_790_000_000_000 });
        answer = () => json({ kept: true });
        expect(await originalOf(`brief.docx`)).toEqual({ keptAt: undefined });
    });

    it(`reads nothing kept, and a backend without the route, as no original`, async () => {
        answer = () => json({ kept: false });
        expect(await originalOf(`brief.docx`)).toBeUndefined();
        answer = () => new Response(`not found`, { status: 404 });
        expect(await originalOf(`brief.docx`)).toBeUndefined();
    });

    it(`fails with the backend's words on any other refusal`, async () => {
        answer = () => new Response(`the folder is gone`, { status: 500 });
        await expect(originalOf(`brief.docx`)).rejects.toThrow(`the folder is gone`);
    });

    it(`is restored by posting the path, and a refused restore fails with the backend's words`, async () => {
        answer = () => json({ restored: true });
        await restoreOriginal(`brief.docx`);
        expect(asked).toEqual([{ path: `restore-original`, method: `POST`, body: { path: `brief.docx` } }]);
        answer = () => new Response(`no original kept for brief.docx`, { status: 404 });
        await expect(restoreOriginal(`brief.docx`)).rejects.toThrow(`no original kept for brief.docx`);
    });
});
