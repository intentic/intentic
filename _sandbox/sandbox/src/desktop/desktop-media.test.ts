import { createHmac } from "node:crypto";
import { pollUntil } from "@intentic/base/async";
import { z } from "zod";
import type { Display } from "../browser/cast/display.js";
import { configureCastd, stopCastd } from "../browser/media/castd.js";
import { answering, castAnswer, FAKE_KEY, fakeCastd, GEOMETRY_SCREEN } from "../browser/media/castd.testing.js";
import { DESKTOP_KEY } from "./agent-desktop.js";
import { desktopPicture } from "./desktop-media.js";

// The desktop's picture on castd: a read-only token until the view takes the desktop, and at each change of hands castd
// first ends the read-write sockets and refuses the read-write tokens minted before it, then the view gets its new one.

const DISPLAY: Display = { name: ":130", width: 1920, height: 1080 };
const WHOLE = { x: 0, y: 0, width: 1920, height: 1080, scale: 1 };

// Whether a token opens a read-only socket, once its MAC is checked the way castd checks it.
const readOnlyOf = (message: string): boolean => {
    const { token } = z.object({ token: z.string() }).parse(JSON.parse(message));
    const [payload = "", mac = ""] = token.split(".");
    const bytes = Buffer.from(payload, "base64url");
    expect(createHmac("sha256", FAKE_KEY).update(bytes).digest("base64url")).toBe(mac);
    return z.object({ ro: z.boolean() }).parse(JSON.parse(bytes.toString("utf8"))).ro;
};

describe("the desktop's picture on castd changing hands", () => {
    test("cuts off the read-write sockets before each new token, so a socket that drove cannot go on driving", async () => {
        const fake = fakeCastd();
        answering(fake, { ...GEOMETRY_SCREEN, crop: { x: 0, y: 0, w: 1920, h: 1080 }, resizable: false });
        fake.answers.set("POST /viewers/drop", castAnswer(200, `{"ok":true,"dropped":1}`));
        configureCastd(fake.deps);
        const sent: string[] = [];
        // What castd had been asked when each token went out.
        const askedAt: number[] = [];
        const send = (text: string): void => {
            sent.push(text);
            askedAt.push(fake.asked.filter((asked) => asked.path.startsWith("/viewers/drop")).length);
        };
        const { media } = await desktopPicture(DISPLAY, undefined, true, async () => WHOLE, send, () => false);
        expect(media).not.toBeUndefined();
        expect(readOnlyOf(sent[0] ?? "")).toBe(true);

        media?.hand(true);
        expect(await pollUntil(() => sent.length === 2, { intervalMs: 5, timeoutMs: 2_000 })).toBe(true);
        expect(readOnlyOf(sent[1] ?? "")).toBe(false);
        media?.hand(false);
        expect(await pollUntil(() => sent.length === 3, { intervalMs: 5, timeoutMs: 2_000 })).toBe(true);
        expect(readOnlyOf(sent[2] ?? "")).toBe(true);
        // Each token after a change of hands went out once castd had cut the read-write sockets.
        expect(askedAt).toEqual([0, 1, 2]);
        const drops = fake.asked.filter((asked) => asked.path.startsWith("/viewers/drop"));
        expect(drops.every((asked) => asked.path.includes("read_write=1"))).toBe(true);
        media?.stop();
        stopCastd(DESKTOP_KEY);
    });
});
