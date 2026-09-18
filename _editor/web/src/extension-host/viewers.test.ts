import type { IntenticApi, ViewerRegistration } from "@intentic/extension-api";
import * as viewers from "@intentic/ext-viewers";
import { describe, expect, it } from "vitest";

// Exercises ext-viewers by calling activate() against a minimal fake IntenticApi, proving it registers every viewer its
// manifest declares.
// This is the only extension covering non-source file formats; a silent registration failure wouldn't throw, it would
// just fall back to downloads instead of previews.

const activateAndCaptureViewers = (): ViewerRegistration[] => {
    const registered: ViewerRegistration[] = [];
    const api = {
        viewers: {
            register: (viewer: ViewerRegistration) => {
                registered.push(viewer);
                return { dispose: () => {} };
            },
        },
    } as unknown as IntenticApi;
    viewers.activate(api, { extensionId: `test`, subscriptions: [] });
    return registered;
};

describe(`ext-viewers`, () => {
    it(`registers a viewer for every format the app previews`, () => {
        const ids = activateAndCaptureViewers()
            .map((viewer) => viewer.id)
            .toSorted();
        expect(ids).toEqual([`docx`, `epub`, `image`, `media`, `odf-slides`, `odf-text`, `pdf`, `pptx`, `rtf`, `svg`, `xlsx`]);
    });

    it(`declares each viewer in the manifest with its file extensions and fetch kind`, () => {
        const declared = new Map((viewers.manifest.contributes?.viewers ?? []).map((viewer) => [viewer.id, viewer]));
        expect(declared.get(`image`)).toEqual({
            id: `image`,
            extensions: [`png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `ico`],
            fetch: `blob`,
        });
        // SVG is fetched as TEXT: it is markup, and one read serves both the picture and the Source toggle.
        expect(declared.get(`svg`)).toEqual({ id: `svg`, extensions: [`svg`], fetch: `text` });
        expect(declared.get(`pdf`)).toEqual({ id: `pdf`, extensions: [`pdf`], fetch: `blob` });
        // The one format with a compare reading: its diff is drawn as one marked document, not two sides.
        expect(declared.get(`docx`)).toEqual({ id: `docx`, extensions: [`docx`], fetch: `blob`, compare: true });
        // One viewer for both spreadsheet formats: its worker decides which it is from the bytes.
        expect(declared.get(`xlsx`)).toEqual({ id: `xlsx`, extensions: [`xlsx`, `ods`, `ots`], fetch: `blob` });
        expect(declared.get(`pptx`)).toEqual({ id: `pptx`, extensions: [`pptx`], fetch: `blob` });
        expect(declared.get(`odf-text`)).toEqual({ id: `odf-text`, extensions: [`odt`, `ott`], fetch: `blob` });
        expect(declared.get(`odf-slides`)).toEqual({ id: `odf-slides`, extensions: [`odp`, `otp`, `odg`, `otg`], fetch: `blob` });
        expect(declared.get(`rtf`)).toEqual({ id: `rtf`, extensions: [`rtf`], fetch: `blob` });
        expect(declared.get(`epub`)).toEqual({ id: `epub`, extensions: [`epub`], fetch: `blob` });
    });

    // Every office format a maker is likely to drop into a workspace, and the one thing that must never happen to
    // one: two viewers claiming it, where the loser is decided by registration order.
    it(`claims each document format exactly once`, () => {
        const claims = new Map<string, string>();
        for (const viewer of viewers.manifest.contributes?.viewers ?? []) {
            for (const extension of viewer.extensions) {
                expect(claims.get(extension)).toBeUndefined();
                claims.set(extension, viewer.id);
            }
        }
        for (const extension of [`docx`, `xlsx`, `pptx`, `pdf`, `odt`, `ods`, `odp`, `odg`, `rtf`, `epub`]) {
            expect(claims.has(extension)).toBe(true);
        }
    });

    // Media is the only `url` viewer: a blob fetch would download the whole file before the first frame and hit the
    // daemon's 25 MiB raw cap for most recordings.
    // Audio and video share one entry because the player decides which it is from the decoded track, not the extension.
    it(`declares audio and video as one streaming viewer`, () => {
        const media = (viewers.manifest.contributes?.viewers ?? []).find((viewer) => viewer.id === `media`);
        expect(media?.fetch).toBe(`url`);
        expect(media?.extensions).toEqual(expect.arrayContaining([`mp3`, `wav`, `flac`, `m4a`, `mp4`, `webm`, `mov`, `mkv`]));
    });

    it(`registers a compare component for the format whose manifest entry declares one, and for no other`, () => {
        const registered = new Map(activateAndCaptureViewers().map((viewer) => [viewer.id, viewer]));
        const declared = new Map((viewers.manifest.contributes?.viewers ?? []).map((viewer) => [viewer.id, viewer]));
        for (const [id, viewer] of registered) {
            expect(viewer.compare !== undefined).toBe(declared.get(id)?.compare === true);
        }
        expect(typeof registered.get(`docx`)?.compare).toBe(`function`);
    });

    it(`registers only viewer ids the manifest declares (the host gates the rest)`, () => {
        const declared = new Set((viewers.manifest.contributes?.viewers ?? []).map((viewer) => viewer.id));
        for (const viewer of activateAndCaptureViewers()) {
            expect(declared.has(viewer.id)).toBe(true);
        }
    });
});
