// SPDX-License-Identifier: AGPL-3.0-only
import { unstubbed } from "@intentic/testing";
import { MEDIA_LIMIT_MB } from "../../../src/protocol.js";
import {
    extensionOf,
    fitWithin,
    freshMediaBase,
    insertMedia,
    insertsMedia,
    installMediaInsert,
    type MediaApi,
    type MediaWindow,
    MEDIA_NAME_PREFIX,
    refusalOf,
} from "./media-insert.js";

// What the page decides before the browser reads a picked file, and the name the medium and its poster share, which
// x2t must read as "a picture with media" or the medium is lost when the presentation is saved.

const MB = 1024 * 1024;

describe(`insertsMedia`, () => {
    const presentation = { documentType: `slide`, mode: `edit`, saveable: true, fileType: `pptx` } as const;

    it(`offers media in an editable OOXML presentation`, () => {
        expect(insertsMedia(presentation)).toBe(true);
        expect(insertsMedia({ ...presentation, fileType: `PPTM` })).toBe(true);
        expect(insertsMedia({ ...presentation, fileType: `potx` })).toBe(true);
    });

    it(`offers none where x2t would not write the medium back, or nothing is saved`, () => {
        expect(insertsMedia({ ...presentation, fileType: `odp` })).toBe(false);
        expect(insertsMedia({ ...presentation, fileType: `ppt`, saveable: false })).toBe(false);
        expect(insertsMedia({ ...presentation, mode: `view` })).toBe(false);
        expect(insertsMedia({ ...presentation, documentType: `word`, fileType: `docx` })).toBe(false);
    });
});

describe(`refusalOf`, () => {
    it(`takes the formats this browser and PowerPoint both play, up to the limit`, () => {
        expect(refusalOf(`video`, { name: `Demo.MP4`, size: 10 * MB })).toBeUndefined();
        expect(refusalOf(`video`, { name: `clip.mov`, size: MEDIA_LIMIT_MB * MB })).toBeUndefined();
        expect(refusalOf(`audio`, { name: `voice.m4a`, size: MB })).toBeUndefined();
    });

    it(`refuses a file over the limit, and one of another kind or format`, () => {
        expect(refusalOf(`video`, { name: `long.mp4`, size: MEDIA_LIMIT_MB * MB + 1 })).toBe(`too-large`);
        expect(refusalOf(`video`, { name: `old.wmv`, size: MB })).toBe(`unreadable`);
        expect(refusalOf(`audio`, { name: `clip.mp4`, size: MB })).toBe(`unreadable`);
        expect(refusalOf(`video`, { name: `noextension`, size: MB })).toBe(`unreadable`);
    });
});

it(`reads an extension in lower case, and none from a dotfile`, () => {
    expect(extensionOf(`a.b.MP4`)).toBe(`mp4`);
    expect(extensionOf(`.mp4`)).toBe(``);
    expect(extensionOf(`clip`)).toBe(``);
});

it(`scales a poster down to fit, never up`, () => {
    expect(fitWithin(3840, 2160, 1920)).toEqual({ width: 1920, height: 1080 });
    expect(fitWithin(1080, 1920, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(fitWithin(320, 240, 1920)).toEqual({ width: 320, height: 240 });
});

describe(`freshMediaBase`, () => {
    it(`names the pair the way x2t pairs a picture with its medium`, () => {
        const base = freshMediaBase(() => false, () => `k3x9`);
        expect(base).toBe(`${MEDIA_NAME_PREFIX}_k3x9`);
        // x2t's test: "display", a digit whose 8 bit says media, then "image" straight after it.
        const marked = /display([1-9])image/.exec(base);
        expect(Number(marked?.[1]) & 8).toBe(8);
    });

    it(`passes over a name the document already holds`, () => {
        const random = jest.fn().mockReturnValueOnce(`taken`).mockReturnValueOnce(`free`);
        expect(freshMediaBase((base) => base.endsWith(`taken`), random)).toBe(`${MEDIA_NAME_PREFIX}_free`);
    });
});

const frameWith = (provided: Partial<MediaWindow>): Window & MediaWindow => unstubbed<Window & MediaWindow>(`frame`, provided);

describe(`installMediaInsert`, () => {
    it(`answers the presentation editor's media buttons, once`, () => {
        const api: MediaApi = { asc_AddVideoCallback: () => undefined };
        const frame = frameWith({ Asc: { editor: api } });
        expect(installMediaInsert(frame, () => undefined)).toBe(true);
        const answer = api.asc_AddVideo;
        expect(answer).toBeInstanceOf(Function);
        expect(api.asc_AddAudio).toBeInstanceOf(Function);
        installMediaInsert(frame, () => undefined);
        expect(api.asc_AddVideo).toBe(answer);
    });

    it(`leaves another editor alone, and waits for one that has not loaded`, () => {
        const api: MediaApi = {};
        expect(installMediaInsert(frameWith({ Asc: { editor: api } }), () => undefined)).toBe(true);
        expect(api.asc_AddVideo).toBeUndefined();
        expect(installMediaInsert(frameWith({ Asc: {} }), () => undefined)).toBe(false);
    });
});

it(`refuses an oversized file before registering anything with the editor`, async () => {
    const added: string[] = [];
    const frame = frameWith({
        Asc: { editor: { WordControl: { m_oLogicDocument: { addImages: () => added.push(`picture`) } } } },
        AscCommon: { g_oDocumentUrls: { addImageUrl: (name: string) => added.push(name), getUrl: () => undefined } },
    });
    const file = new File([new Uint8Array(1)], `long.mp4`, { type: `video/mp4` });
    Object.defineProperty(file, `size`, { value: MEDIA_LIMIT_MB * MB + 1 });
    expect(await insertMedia(frame, `video`, file)).toBe(`too-large`);
    expect(added).toEqual([]);
});
