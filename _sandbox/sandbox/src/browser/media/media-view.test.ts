import { createHmac } from "node:crypto";
import { pollUntil } from "@intentic/base/async";
import { unstubbed } from "@intentic/testing";
import type { BrowserContext } from "playwright";
import { z } from "zod";
import { configureCastd, stopCastd } from "./castd.js";
import { answering, FAKE_KEY, fakeCastd, GEOMETRY_SCREEN } from "./castd.testing.js";
import type { Display } from "../cast/display.js";
import { mediaMessage, startMediaView, TOKEN_TTL_MS } from "./media-view.js";

// The handoff: a window castd serves gets `media {path, token, expiresAt}` on its browser view socket and no picture
// there, a token castd will take, and a fresh one whenever castd starts again. A window castd cannot serve gets nothing,
// and the caller (live-view.ts) shows it the old way.

const DISPLAY: Display = { name: ":120", width: 2560, height: 1600 };

// A browser with no pages yet: the view follows none, and the window is cut from the screen (no kiosk to read).
const noPages = (): BrowserContext => {
    const context: BrowserContext = unstubbed<BrowserContext>("context", { pages: () => [], on: () => context, off: () => context });
    return context;
};

const noFront = { page: () => undefined, watch: () => () => undefined };

interface Claims {
    readonly s: string;
    readonly exp: number;
    readonly ro: boolean;
    readonly iat?: number;
}

// The claims a token carries, once its MAC is checked the way castd checks it.
const verified = (token: string): Claims => {
    const [payload = "", mac = ""] = token.split(".");
    const bytes = Buffer.from(payload, "base64url");
    expect(createHmac("sha256", FAKE_KEY).update(bytes).digest("base64url")).toBe(mac);
    const claims: Claims = JSON.parse(bytes.toString("utf8"));
    return claims;
};

// What a viewer's socket was sent: text as it is, and any binary message (a picture) as a marker.
interface RecordingSink {
    readonly sent: string[];
    readonly send: (data: string | Uint8Array<ArrayBuffer>) => void;
}

const sinkOf = (): RecordingSink => {
    const sent: string[] = [];
    return { sent, send: (data) => sent.push(data instanceof Uint8Array ? "<binary>" : data) };
};

const MediaSchema = z.object({ type: z.literal("media"), path: z.string(), token: z.string(), expiresAt: z.number() });

const mediaAt = (sink: RecordingSink, index: number): z.infer<typeof MediaSchema> => MediaSchema.parse(JSON.parse(sink.sent[index] ?? "{}"));

describe("mediaMessage", () => {
    test("names the window's media path and carries a token for its castd, lapsing a minute on", () => {
        const message = mediaMessage({ path: "/system/browser-media/cast-_own", castd: { session: "cast-_own" } }, FAKE_KEY, false, 1_700_000_000_000);
        expect(message).toMatchObject({ type: "media", path: "/system/browser-media/cast-_own", expiresAt: 1_700_000_060_000 });
        expect(TOKEN_TTL_MS).toBe(60_000);
        // Minted now: castd refuses one minted before the window's viewers were last dropped.
        expect(verified(message.type === "media" ? message.token : "")).toEqual({ s: "cast-_own", exp: 1_700_000_060_000, ro: false, iat: 1_700_000_000_000 });
    });
});

describe("startMediaView", () => {
    test("a window castd serves is handed its media socket, and this socket carries no picture", async () => {
        const fake = fakeCastd();
        answering(fake, { ...GEOMETRY_SCREEN, crop: { x: 0, y: 0, w: 2560, h: 1600 }, resizable: false });
        configureCastd(fake.deps);
        const sink = sinkOf();
        const view = await startMediaView(noPages(), "handoff@example.com", DISPLAY, sink, { front: noFront });
        expect(view).not.toBeUndefined();
        expect(sink.sent).toHaveLength(1);
        const { token, path } = mediaAt(sink, 0);
        expect(path).toMatch(/^\/system\/browser-media\/cast-handoff_example_com-[0-9a-f]{8}$/u);
        expect(verified(token)).toMatchObject({ s: path.split("/").at(-1), ro: false });
        // Pointer and keys are castd's now: one sent here is dropped, answered with nothing.
        await view?.input({ type: "mouse", action: "down", x: 10, y: 10, button: 0 });
        await view?.input({ type: "key", key: "a" });
        expect(sink.sent).toHaveLength(1);
        // A viewer whose token lapsed asks for a fresh one, and gets it at once.
        await view?.input({ type: "media" });
        expect(sink.sent).toHaveLength(2);
        expect(mediaAt(sink, 1).path).toBe(path);
        expect(fake.children[0]?.args).toContain("--crop");
        await view?.stop();
        stopCastd("handoff@example.com");
    });

    test("a viewer who may only watch gets a read-only token", async () => {
        const fake = fakeCastd();
        answering(fake, { ...GEOMETRY_SCREEN, crop: { x: 0, y: 0, w: 2560, h: 1600 }, resizable: false });
        configureCastd(fake.deps);
        const sink = sinkOf();
        const view = await startMediaView(noPages(), "watcher@example.com", DISPLAY, sink, { front: noFront, readOnly: true });
        expect(verified(mediaAt(sink, 0).token).ro).toBe(true);
        await view?.stop();
        stopCastd("watcher@example.com");
    });

    test("castd starting afresh hands the viewer a fresh token at once, since its socket went with the last one", async () => {
        const fake = fakeCastd();
        answering(fake, { ...GEOMETRY_SCREEN, crop: { x: 0, y: 0, w: 2560, h: 1600 }, resizable: false });
        configureCastd(fake.deps);
        const sink = sinkOf();
        const view = await startMediaView(noPages(), "restart@example.com", DISPLAY, sink, { front: noFront });
        fake.children[0]?.exit(101);
        // castd's backoff floor is half a second; this only bounds the wait.
        expect(await pollUntil(() => sink.sent.length === 2, { intervalMs: 20, timeoutMs: 5_000 })).toBe(true);
        expect(mediaAt(sink, 1).path).toBe(mediaAt(sink, 0).path);
        await view?.stop();
        stopCastd("restart@example.com");
    });

    test("a window whose display came back on another number is served by a castd on that display, not the dead one's", async () => {
        const fake = fakeCastd();
        answering(fake, { ...GEOMETRY_SCREEN, crop: { x: 0, y: 0, w: 2560, h: 1600 }, resizable: false });
        configureCastd(fake.deps);
        const first = await startMediaView(noPages(), "moved@example.com", DISPLAY, sinkOf(), { front: noFront });
        await first?.stop();
        // Its X server died and was not released: the key's next display took the next free number.
        const second = await startMediaView(noPages(), "moved@example.com", { ...DISPLAY, name: ":121" }, sinkOf(), { front: noFront });
        expect(fake.children.at(-1)?.args).toContain(":121");
        expect(fake.children.filter((child) => fake.live.has(child.pid))).toHaveLength(1);
        await second?.stop();
        stopCastd("moved@example.com");
    });

    test("no castd binary, or one that never answers, leaves the window to the old path with nothing sent", async () => {
        const absent = fakeCastd({ binary: () => undefined });
        configureCastd(absent.deps);
        const sink = sinkOf();
        expect(await startMediaView(noPages(), "absent@example.com", DISPLAY, sink, { front: noFront })).toBeUndefined();
        const silent = fakeCastd({ startMs: 100 });
        configureCastd(silent.deps);
        expect(await startMediaView(noPages(), "silent@example.com", DISPLAY, sink, { front: noFront })).toBeUndefined();
        expect(sink.sent).toEqual([]);
        stopCastd("silent@example.com");
    });
});
