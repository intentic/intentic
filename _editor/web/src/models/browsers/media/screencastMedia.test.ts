// The media path beside a window's own socket: it asks for castd with `media=1`, takes `media` as its own, steps aside
// when the window's socket sends its own `ready`, and gives up on a media socket that never says hello, dialling the
// window's socket again without asking for castd.
import "@intentic/testing/dom";
import { ref, shallowRef } from "vue";
import type { MediaPicture } from "./mediaPicture";
import type { MediaOffer } from "./mediaMessages";
import { GIVE_UP_MS, screencastMedia } from "./screencastMedia";

const fakePicture = () => {
    const offers: MediaOffer[] = [];
    let stops = 0;
    const hello = shallowRef<MediaPicture[`hello`][`value`]>();
    const picture: Pick<MediaPicture, `hello` | `live` | `offer` | `stop` | `dispose`> = {
        hello,
        live: ref(false),
        offer: (offer) => offers.push(offer),
        stop: () => (stops += 1),
        dispose: () => undefined,
    };
    return { picture, offers, hello, stops: () => stops };
};

const setup = () => {
    const fake = fakePicture();
    const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
    let redials = 0;
    let helloSeen: MediaPicture[`hello`][`value`];
    let capturedHello: ((hello: NonNullable<MediaPicture[`hello`][`value`]>) => void) | undefined;
    let capturedFailed: ((message: string) => void) | undefined;
    const media = screencastMedia({
        askFresh: () => undefined,
        redial: () => (redials += 1),
        onHello: (hello) => (helloSeen = hello),
        onPicture: () => undefined,
        onDrop: () => undefined,
        picture: (options) => {
            capturedHello = options.onHello;
            capturedFailed = options.onFailed;
            // SAFETY: the path under test reads only the members the fake carries (hello, live, offer, stop, dispose).
            return fake.picture as MediaPicture;
        },
        later: (run, ms) => {
            const timer = { run, ms, cancelled: false };
            timers.push(timer);
            return () => (timer.cancelled = true);
        },
    });
    return {
        media,
        fake,
        timers,
        redials: () => redials,
        sayHello: () => capturedHello?.({ type: `hello`, width: 10, height: 10, scale: 1, codec: `avc1`, readOnly: false, audio: undefined }),
        helloSeen: () => helloSeen,
        decoderFailed: (message: string) => capturedFailed?.(message),
    };
};

const offer = { type: `media`, path: `/system/browser-media/cast-1`, token: `t.m`, expiresAt: 9e12 };

it("asks the window's socket for castd, and keeps `media` to itself", () => {
    const { media, fake } = setup();
    expect(media.address(`wss://x/system/browser-view?ticket=a`)).toBe(`wss://x/system/browser-view?ticket=a&media=1`);
    expect(media.address(undefined)).toBeUndefined();
    expect(media.take(offer)).toBe(true);
    expect(media.take({ type: `state` })).toBe(false);
    expect(fake.offers).toEqual([{ path: offer.path, token: offer.token, expiresAt: offer.expiresAt }]);
});

it("steps aside when the window's socket sends its own picture", () => {
    const { media, fake } = setup();
    media.take(offer);
    media.ready();
    expect(fake.stops()).toBe(1);
});

it("gives up on a media socket that never says hello, and asks the window's socket again without castd", () => {
    const { media, fake, timers, redials } = setup();
    media.take(offer);
    expect(timers.map((timer) => timer.ms)).toEqual([GIVE_UP_MS]);
    timers[0]!.run();
    expect(redials()).toBe(1);
    expect(fake.stops()).toBe(1);
    expect(media.address(`wss://x/v?a=1`)).toBe(`wss://x/v?a=1`);
    // Another window tries castd again.
    media.reset();
    expect(media.address(`wss://x/v`)).toBe(`wss://x/v?media=1`);
});

it("opens the media socket on the base the window's socket was dialled on, loopback shortcut or edge alike", () => {
    let base: (() => string | undefined) | undefined;
    const media = screencastMedia({
        askFresh: () => undefined,
        redial: () => undefined,
        onHello: () => undefined,
        onPicture: () => undefined,
        onDrop: () => undefined,
        picture: (options) => {
            base = options.base;
            // SAFETY: only `base` is read off the options; the picture itself is never touched here.
            return fakePicture().picture as MediaPicture;
        },
    });
    expect(base?.()).toBeUndefined();
    media.address(`https://sandbox.localhost.example:28123/system/browser-view?ticket=a`);
    expect(base?.()).toBe(`https://sandbox.localhost.example:28123`);
    media.address(`http://127.0.0.1:28123/system/browser-view?ticket=b`);
    expect(base?.()).toBe(`http://127.0.0.1:28123`);
    media.address(`wss://sandbox-abcdef012345.sbx.example.test/system/browser-view?ticket=c`);
    expect(base?.()).toBe(`wss://sandbox-abcdef012345.sbx.example.test`);
    // A mint that found no sandbox keeps the way in the last socket took.
    media.address(undefined);
    expect(base?.()).toBe(`wss://sandbox-abcdef012345.sbx.example.test`);
});

it("stops waiting to give up once castd says hello", () => {
    const { media, timers, sayHello, helloSeen } = setup();
    media.take(offer);
    sayHello();
    expect(timers[0]?.cancelled).toBe(true);
    expect(helloSeen()).toMatchObject({ width: 10 });
});

it("goes back to the window's own pictures when this browser cannot decode castd's stream", () => {
    const { media, fake, sayHello, redials, decoderFailed } = setup();
    media.take(offer);
    sayHello();
    decoderFailed(`Unsupported configuration`);
    expect(fake.stops()).toBe(1);
    expect(redials()).toBe(1);
    expect(media.address(`wss://x/v`)).toBe(`wss://x/v`);
});

it("takes no offer once disposed, so a window socket kept for a save is never dialled again", () => {
    const { media, fake, timers, redials } = setup();
    media.dispose();
    // A fresh token the window's socket sends while its save is still pending.
    expect(media.take(offer)).toBe(true);
    for (const timer of timers) {
        timer.run();
    }
    expect(redials()).toBe(0);
    expect(fake.offers).toEqual([]);
});
