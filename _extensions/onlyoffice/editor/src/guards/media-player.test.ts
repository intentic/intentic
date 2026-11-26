// SPDX-License-Identifier: AGPL-3.0-only
import { waitFor } from "@intentic/testing/bun";
import type { MediaProblem } from "../../../src/protocol.js";
import { clockOf, labelsFor } from "./media-controls.js";
import { actionOf, firstVideoOf, installMediaPlayer, type MediaData, type PlayerApi, type PlayerData, type Slide, transformOf, volumeOf } from "./media-player.js";

// The player against a scripted presentation editor in this window: what each command shows, where, and what it tells
// the page. Playback itself is the browser's and is checked in a real one (scripts/browser-engine-harness.ts).

describe(`actionOf`, () => {
    it(`reads the editor's commands, the slideshow's timing ones included`, () => {
        expect(actionOf(`hideMediaControl`)).toEqual({ kind: `hide` });
        expect(actionOf(`showMediaControl`)).toEqual({ kind: `show` });
        expect(actionOf(`update`)).toEqual({ kind: `show` });
        expect(actionOf(`play`)).toEqual({ kind: `play`, from: undefined });
        expect(actionOf(`resume`)).toEqual({ kind: `play`, from: undefined });
        expect(actionOf(`playFrom(2.5)`)).toEqual({ kind: `play`, from: 2.5 });
        expect(actionOf(`pause`)).toEqual({ kind: `pause` });
        expect(actionOf(`stop`)).toEqual({ kind: `stop` });
        expect(actionOf(`togglePause`)).toEqual({ kind: `toggle` });
    });
});

it(`turns and mirrors the medium as its picture is`, () => {
    expect(transformOf({})).toBe(`rotate(0rad) scale(1, 1)`);
    expect(transformOf({ Rotation: 1.5, FlipH: true })).toBe(`rotate(1.5rad) scale(-1, 1)`);
});

it(`reads the slideshow's volume in thousandths of a percent`, () => {
    expect(volumeOf(80_000)).toBe(0.8);
    expect(volumeOf(null)).toBe(1);
    expect(volumeOf(250_000)).toBe(1);
});

it(`shows times as minutes and seconds`, () => {
    expect(clockOf(0)).toBe(`0:00`);
    expect(clockOf(75.9)).toBe(`1:15`);
    expect(clockOf(Number.NaN)).toBe(`0:00`);
});

it(`labels the controls in the interface language, English otherwise`, () => {
    expect(labelsFor(`pl-PL`).play).toBe(`Odtwórz`);
    expect(labelsFor(`ja`).play).toBe(`Play`);
});

const frameRect = { X: 100, Y: 80, W: 320, H: 240 };
const controlRect = { X: 110, Y: 270, W: 300, H: 40 };
// The first slide holds a picture and, in a group, the video; the second holds nothing.
const handle: MediaData = { getDrawing: () => ({ parent: slide }) };
const slide: Slide = {
    cSld: { spTree: [{ isVideo: () => false, getMediaData: () => null }, { spTree: [{ isVideo: () => true, getMediaData: () => handle }] }] },
};
const otherSlide: Slide = {};

// Each test's editor, closed once the test is over: a player keeps following its medium on this shared window until its
// editor hides it and places nothing any more.
const closers: (() => void)[] = [];

// A presentation editor whose medium sits on the first slide, and the media its document holds.
const scripted = (overrides: Partial<PlayerData> = {}) => {
    let open = true;
    const problems: MediaProblem[] = [];
    const callbacks = new Map<string, () => void>();
    const logic = { CurPage: 0, Slides: [slide, otherSlide] };
    const api: PlayerApi = {
        WordControl: { GetMediaPlayerData: () => undefined, DemonstrationManager: { Mode: false, SlideNum: 0 }, m_oLogicDocument: logic },
        asc_registerCallback: (name, callback) => callbacks.set(name, callback),
        getPlayerData(this: PlayerApi, command: string) {
            return !open || this.mediaData === null || this.mediaData === undefined
                ? { Cmd: command }
                : { Cmd: command, MediaFile: `display8image1.mp4`, FrameRect: frameRect, ControlRect: controlRect, IsVideo: true, Theme: `dark`, ...overrides };
        },
        callMediaPlayerCommand: () => undefined,
    };
    closers.push(() => {
        open = false;
        api.callMediaPlayerCommand?.(`hideMediaControl`, null);
    });
    const urls = { getImageUrl: (name: string) => (name === `display8image1.mp4` ? `blob:https://office.example/clip` : undefined) };
    const frame = Object.assign(window, { Asc: { editor: api }, AscCommon: { g_oDocumentUrls: urls } });
    expect(installMediaPlayer(frame, { mediaProblem: (problem) => problems.push(problem), lang: `en` })).toBe(true);
    return { api, logic, problems, callbacks };
};

it(`finds a slide's first video, in a group too`, () => {
    expect(firstVideoOf(slide)).toBe(handle);
    expect(firstVideoOf(otherSlide)).toBeUndefined();
    expect(firstVideoOf(undefined)).toBeUndefined();
});

const bar = (): HTMLElement | null => document.querySelector(`#oo-media-player .bar`);
const stage = (): HTMLElement | null => document.querySelector(`#oo-media-player .stage`);
const video = (): HTMLVideoElement | null => document.querySelector(`#oo-media-player video`);

beforeEach(() => {
    jest.spyOn(HTMLMediaElement.prototype, `play`).mockImplementation(() => Promise.resolve());
    jest.spyOn(HTMLMediaElement.prototype, `pause`).mockImplementation(() => undefined);
});

afterEach(() => {
    for (const close of closers.splice(0)) {
        close();
    }
    jest.restoreAllMocks();
    Reflect.deleteProperty(window, `Asc`);
    Reflect.deleteProperty(window, `AscCommon`);
    document.body.replaceChildren();
});

describe(`installMediaPlayer`, () => {
    it(`shows its controls where the editor places them, over the medium's picture, in the editor's theme`, () => {
        const { api } = scripted();
        api.callMediaPlayerCommand?.(`showMediaControl`, handle);
        expect(bar()?.style.display).toBe(`flex`);
        expect([bar()?.style.left, bar()?.style.top, bar()?.style.width, bar()?.style.height]).toEqual([`110px`, `270px`, `300px`, `40px`]);
        expect(bar()?.dataset[`theme`]).toBe(`dark`);
        expect([stage()?.style.left, stage()?.style.width]).toEqual([`100px`, `320px`]);
        // The picture shows until the medium plays.
        expect(stage()?.style.display).toBe(`none`);
        expect(video()?.getAttribute(`src`)).toBe(`blob:https://office.example/clip`);
        expect(bar()?.querySelector(`button`)?.getAttribute(`aria-label`)).toBe(`Play`);
    });

    it(`plays on the slideshow's command and stops showing when the editor lets go of a paused medium`, () => {
        const { api } = scripted();
        api.callMediaPlayerCommand?.(`play`, handle);
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
        // The stubbed play leaves the medium paused.
        api.callMediaPlayerCommand?.(`hideMediaControl`, null);
        expect(bar()?.style.display).toBe(`none`);
        expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
        expect(api.mediaData).toBeNull();
    });

    it(`plays on once the pointer leaves a playing medium in a slideshow, and stops when its slide is left`, async () => {
        const { api } = scripted();
        const demo = api.WordControl?.DemonstrationManager;
        if (demo !== undefined) {
            demo.Mode = true;
        }
        api.callMediaPlayerCommand?.(`showMediaControl`, handle);
        // Playing a second in, as a browser would say once the stubbed play had started it (jsdom has no media error).
        const media = video();
        if (media !== null) {
            Object.defineProperties(media, { paused: { get: () => false }, currentTime: { get: () => 1, set: () => {} }, error: { get: () => null } });
        }
        api.callMediaPlayerCommand?.(`play`, handle);
        api.callMediaPlayerCommand?.(`hideMediaControl`, null);
        expect(bar()?.style.display).toBe(`none`);
        expect(stage()?.style.display).toBe(`block`);
        expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
        expect(api.mediaData).toBeNull();
        // Still followed where the editor places it, though the editor dropped its handle.
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        expect(stage()?.style.display).toBe(`block`);
        expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
        expect(api.mediaData).toBeNull();
        // Hovered again: the controls come back over the same playback.
        api.callMediaPlayerCommand?.(`showMediaControl`, handle);
        expect(bar()?.style.display).toBe(`flex`);
        expect(bar()?.querySelector(`button`)?.getAttribute(`aria-label`)).toBe(`Pause`);
        api.callMediaPlayerCommand?.(`hideMediaControl`, null);
        if (demo !== undefined) {
            demo.SlideNum = 1;
        }
        await waitFor(() => expect(stage()?.style.display).toBe(`none`));
        expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
    });

    it(`starts a slideshow slide's video once the slide's transition is over`, async () => {
        const { api, callbacks } = scripted();
        let transitioning = true;
        const demo = api.WordControl?.DemonstrationManager;
        if (demo !== undefined) {
            Object.assign(demo, { Mode: true, SlideNum: 0, Transition: { IsPlaying: () => transitioning } });
        }
        callbacks.get(`asc_onDemonstrationSlideChanged`)?.();
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
        transitioning = false;
        await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
        expect(api.mediaData).toBe(handle);
        // Started, not hovered: the controls wait for the pointer.
        expect(bar()?.style.display).toBe(`none`);
    });

    it(`starts nothing on a slideshow slide without a video`, async () => {
        const { api, callbacks } = scripted();
        const demo = api.WordControl?.DemonstrationManager;
        if (demo !== undefined) {
            Object.assign(demo, { Mode: true, SlideNum: 1 });
        }
        callbacks.get(`asc_onDemonstrationSlideChanged`)?.();
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
        expect(bar()).toBeNull();
    });

    it(`plays on, not over, when the slide's timing plays the video already playing`, () => {
        const { api } = scripted();
        api.callMediaPlayerCommand?.(`showMediaControl`, handle);
        const seeks: number[] = [];
        const media = video();
        if (media !== null) {
            Object.defineProperties(media, {
                paused: { get: () => false },
                currentTime: {
                    get: () => 5,
                    set: (at: number) => {
                        seeks.push(at);
                    },
                },
            });
        }
        api.callMediaPlayerCommand?.(`playFrom(0)`, handle);
        expect(seeks).toEqual([]);
    });

    it(`keeps a click on its controls from reaching the slide under them`, () => {
        const { api } = scripted();
        api.callMediaPlayerCommand?.(`showMediaControl`, handle);
        const heard: string[] = [];
        document.body.addEventListener(`mousedown`, () => heard.push(`mousedown`));
        bar()?.dispatchEvent(new MouseEvent(`mousedown`, { bubbles: true }));
        expect(heard).toEqual([]);
    });

    it(`shows nothing for a medium the document does not hold`, () => {
        const { api } = scripted({ MediaFile: `display8image9.mp4` });
        api.callMediaPlayerCommand?.(`showMediaControl`, handle);
        expect(bar()?.style.display).toBe(`none`);
        expect(video()?.hasAttribute(`src`)).toBe(false);
    });

    it(`says once that a medium cannot be played here`, () => {
        const { api, problems } = scripted();
        api.callMediaPlayerCommand?.(`showMediaControl`, handle);
        video()?.dispatchEvent(new Event(`error`));
        video()?.dispatchEvent(new Event(`error`));
        expect(problems).toEqual([`unplayable`]);
        expect(bar()?.querySelector(`button`)?.hasAttribute(`disabled`)).toBe(true);
    });

    it(`lets go once the editor moves to another slide`, async () => {
        const { api, logic } = scripted();
        api.callMediaPlayerCommand?.(`showMediaControl`, handle);
        logic.CurPage = 1;
        await waitFor(() => expect(bar()?.style.display).toBe(`none`));
    });

    it(`lets go once the slideshow it played in ends`, async () => {
        const { api } = scripted();
        const demo = api.WordControl?.DemonstrationManager;
        if (demo !== undefined) {
            demo.Mode = true;
        }
        api.callMediaPlayerCommand?.(`showMediaControl`, handle);
        expect(bar()?.style.display).toBe(`flex`);
        if (demo !== undefined) {
            demo.Mode = false;
        }
        await waitFor(() => expect(bar()?.style.display).toBe(`none`));
        expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
        expect(api.mediaData).toBeNull();
    });

    it(`follows an update only while showing, and only in the mode it showed in`, () => {
        const { api } = scripted();
        api.callMediaPlayerCommand?.(`update`, handle);
        expect(bar()).toBeNull();
        api.callMediaPlayerCommand?.(`showMediaControl`, handle);
        api.callMediaPlayerCommand?.(`update`, handle);
        expect(bar()?.style.display).toBe(`flex`);
        const demo = api.WordControl?.DemonstrationManager;
        if (demo !== undefined) {
            demo.Mode = true;
        }
        api.callMediaPlayerCommand?.(`update`, handle);
        expect(bar()?.style.display).toBe(`none`);
        expect(api.mediaData).toBeNull();
    });

    it(`leaves another editor's command alone`, () => {
        const original = (): void => undefined;
        const api: PlayerApi = { WordControl: {}, getPlayerData: () => null, callMediaPlayerCommand: original };
        const frame = Object.assign(window, { Asc: { editor: api }, AscCommon: { g_oDocumentUrls: {} } });
        expect(installMediaPlayer(frame, { mediaProblem: () => undefined, lang: `en` })).toBe(true);
        expect(api.callMediaPlayerCommand).toBe(original);
    });
});
