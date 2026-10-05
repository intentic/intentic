import type { PhoneSummary } from "@intentic/sandbox-contract";
import { registerPhoneWake } from "./phoneWake";

// Making a phone wakeable from the editor: only a phone whose token nobody registered is registered, the relay's grant
// reaches the sandbox as a relay channel, and a platform without an Android relay reads as unavailable, not broken.

const phone = (wake: PhoneSummary[`wake`], fcm?: string): Pick<PhoneSummary, `id` | `wake` | `facts`> => ({
    id: `pixel`,
    wake,
    facts: {
        device: `Google Pixel 8`,
        android: `16`,
        sdk: 36,
        build: `direct`,
        paused: false,
        access: { accessibility: false, notifications: false, screenCapture: `consent` },
        folders: [],
        apps: [],
        ...(fcm === undefined ? {} : { wake: { fcm } }),
    },
});

const grant = { deviceId: `dev-1`, secret: `s3cret`, url: `https://api.intentic.dev/rpc/push/send` };

test(`registers the phone's current token and hands the sandbox the relay channel`, async () => {
    const register = jest.fn(async () => grant);
    const post = jest.fn(async (_path: string, _init: RequestInit) => new Response(`{"ok":true}`, { status: 200 }));
    expect(await registerPhoneWake(phone(`register`, `fcm-1`), { register, post })).toBe(`ready`);
    expect(register).toHaveBeenCalledWith(`fcm-1`);
    expect(post.mock.calls[0]?.[0]).toBe(`/system/phones/pixel/wake`);
    expect(JSON.parse(String(post.mock.calls[0]?.[1].body))).toEqual({
        token: `fcm-1`,
        channel: { kind: `relay`, url: grant.url, deviceId: grant.deviceId, secret: grant.secret },
    });
});

test(`does nothing for a phone already wakeable, or one with no token to register`, async () => {
    const register = jest.fn(async () => grant);
    expect(await registerPhoneWake(phone(`ready`, `fcm-1`), { register })).toBeUndefined();
    expect(await registerPhoneWake(phone(`none`), { register })).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
});

test(`a platform with no Android relay is unavailable; any other failure is a failure`, async () => {
    const missing = jest.fn(async () => {
        throw Object.assign(new Error(`this platform has no push relay`), { code: `NOT_FOUND` });
    });
    expect(await registerPhoneWake(phone(`register`, `fcm-1`), { register: missing })).toBe(`unavailable`);
    const down = jest.fn(async () => {
        throw new Error(`network`);
    });
    expect(await registerPhoneWake(phone(`register`, `fcm-1`), { register: down })).toBe(`failed`);
    const refused = jest.fn(async () => new Response(`{}`, { status: 403 }));
    expect(await registerPhoneWake(phone(`register`, `fcm-1`), { register: async () => grant, post: refused })).toBe(`failed`);
});
