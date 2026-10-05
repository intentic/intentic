import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhoneFacts, RelayChannel } from "@intentic/sandbox-contract";
import { filePhoneWake, WAKE_NOTIFICATION } from "./phone-wake.js";

/* The wake channels the editor registers, as the sandbox keeps and uses them. */

const channel: RelayChannel = { kind: "relay", url: "https://api.intentic.dev/v1/push/send", deviceId: "dev-1", secret: "s3cret" };
const facts = (fcm?: string): PhoneFacts =>
    ({
        device: "Pixel",
        android: "16",
        sdk: 36,
        build: "direct",
        paused: false,
        access: { accessibility: false, notifications: false, screenCapture: "consent" },
        folders: [],
        apps: [],
        ...(fcm === undefined ? {} : { wake: { fcm } }),
    }) as PhoneFacts;
const logger = { warn: () => {} };
const root = () => mkdtempSync(join(tmpdir(), "phone-wake-"));

test("a phone is wakeable once a channel for its current token is held, and asks again when its token rotates", async () => {
    const wake = filePhoneWake(root(), logger, async () => ({ delivered: true }));
    expect(await wake.state("pixel", facts("token-a"))).toBe("register");
    expect(await wake.state("pixel", facts())).toBe("none");
    await wake.register("pixel", { token: "token-a", channel });
    expect(await wake.state("pixel", facts("token-a"))).toBe("ready");
    expect(await wake.state("pixel", undefined)).toBe("ready");
    expect(await wake.state("pixel", facts("token-b"))).toBe("register");
});

test("a wake goes through the relay carrying nothing but the wake itself", async () => {
    const sent: unknown[] = [];
    const wake = filePhoneWake(root(), logger, async (to, notification) => {
        sent.push({ to, notification });
        return { delivered: true };
    });
    expect(await wake.send("pixel")).toBe(false);
    await wake.register("pixel", { token: "token-a", channel });
    expect(await wake.send("pixel")).toBe(true);
    expect(sent).toEqual([{ to: channel, notification: WAKE_NOTIFICATION }]);
    expect(WAKE_NOTIFICATION.body).toBe("");
});

test("a channel the relay calls dead is forgotten, so the card asks for a fresh registration", async () => {
    const wake = filePhoneWake(root(), logger, async () => ({ delivered: false, dead: true }));
    await wake.register("pixel", { token: "token-a", channel });
    expect(await wake.send("pixel")).toBe(false);
    expect(await wake.state("pixel", facts("token-a"))).toBe("register");
});

test("a passing relay failure keeps the channel", async () => {
    const wake = filePhoneWake(root(), logger, async () => ({ delivered: false, error: new Error("502") }));
    await wake.register("pixel", { token: "token-a", channel });
    expect(await wake.send("pixel")).toBe(false);
    expect(await wake.state("pixel", facts("token-a"))).toBe("ready");
});

test("a renamed card keeps its channel and a removed one loses it", async () => {
    const wake = filePhoneWake(root(), logger, async () => ({ delivered: true }));
    await wake.register("pixel", { token: "token-a", channel });
    await wake.rekey("pixel", "my-phone");
    expect(await wake.state("my-phone", facts("token-a"))).toBe("ready");
    expect(await wake.state("pixel", facts("token-a"))).toBe("register");
    await wake.forget("my-phone");
    expect(await wake.state("my-phone", facts("token-a"))).toBe("register");
});
