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
        expect(ids).toEqual([`docx`, `image`, `media`, `pdf`, `svg`, `xlsx`]);
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
        expect(declared.get(`docx`)).toEqual({ id: `docx`, extensions: [`docx`], fetch: `blob` });
        expect(declared.get(`xlsx`)).toEqual({ id: `xlsx`, extensions: [`xlsx`], fetch: `blob` });
    });

    // Media is the only `url` viewer: a blob fetch would download the whole file before the first frame and hit the
    // daemon's 25 MiB raw cap for most recordings.
    // Audio and video share one entry because the player decides which it is from the decoded track, not the extension.
    it(`declares audio and video as one streaming viewer`, () => {
        const media = (viewers.manifest.contributes?.viewers ?? []).find((viewer) => viewer.id === `media`);
        expect(media?.fetch).toBe(`url`);
        expect(media?.extensions).toEqual(expect.arrayContaining([`mp3`, `wav`, `flac`, `m4a`, `mp4`, `webm`, `mov`, `mkv`]));
    });

    it(`registers only viewer ids the manifest declares (the host gates the rest)`, () => {
        const declared = new Set((viewers.manifest.contributes?.viewers ?? []).map((viewer) => viewer.id));
        for (const viewer of activateAndCaptureViewers()) {
            expect(declared.has(viewer.id)).toBe(true);
        }
    });
});
