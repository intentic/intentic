import { PHONE_PASSWORDS_PATHS, PhoneKeyringsResultSchema } from "@intentic/sandbox-contract/schemas/phone-passwords";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { KeyringComputer, KeyringLink } from "../secrets/device/keyring-link.js";
import { fakeKeyring } from "../secrets/device/keyring.testing.js";
import type { PhonePairings } from "./phone-pairings.js";
import { createPhonePasswordsRoutes } from "./phone-passwords.routes.js";

// The phone's Passwords door over HTTP: only an enrolled phone's token gets in, each phone within its rate, a pairing
// the keyring said yes to is remembered as `paired`, and the door carries the phone's own captures alone.

const KEY = "A".repeat(43);
const TOKEN = "iph_pixel-token";

const computer = (machine: string, over: Partial<KeyringComputer> = {}): KeyringComputer => ({
    machine,
    online: true,
    setUp: true,
    locked: false,
    remember: { browser: false, terminal: false, apps: false, phone: true, sandbox: false },
    inbox: KEY,
    activeAt: 1,
    ...over,
});

const memoryPairings = (): PhonePairings => {
    const pairings = new Map<string, Set<string>>();
    return {
        of: async (phone) => new Set(pairings.get(phone)),
        add: async ({ phone, keyring }) => void pairings.set(phone, new Set([...(pairings.get(phone) ?? []), keyring])),
    };
};

const stand = (computers: readonly KeyringComputer[] = [computer("rog")]) => {
    const keyring = fakeKeyring();
    let clock = 0;
    const link: Pick<KeyringLink, "computers" | "passwords"> = {
        computers: async () => computers,
        passwords: {
            capture: (_machine, item) => keyring.client.keyringCapture(item),
            need: (_machine, need) => keyring.client.keyringNeed(need),
            phonePair: (_machine, keys) => keyring.client.keyringPhonePair(keys),
            phoneFill: (_machine, fill) => keyring.client.keyringPhoneFill(fill),
        },
    };
    const routes = createPhonePasswordsRoutes({
        phones: { verify: async (presented) => (presented === TOKEN ? { kind: "enrolled", id: "pixel", card: "pixel" } : { kind: "unknown" }) },
        link,
        pairings: memoryPairings(),
        now: () => clock,
    });
    const app = new Hono<AppEnv>()
        .get(PHONE_PASSWORDS_PATHS.keyrings, routes[`GET ${PHONE_PASSWORDS_PATHS.keyrings}`])
        .post(PHONE_PASSWORDS_PATHS.pair, routes[`POST ${PHONE_PASSWORDS_PATHS.pair}`])
        .post(PHONE_PASSWORDS_PATHS.capture, routes[`POST ${PHONE_PASSWORDS_PATHS.capture}`])
        .post(PHONE_PASSWORDS_PATHS.fill, routes[`POST ${PHONE_PASSWORDS_PATHS.fill}`]);
    const call = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
        app.request(path, {
            method: init.method ?? "GET",
            headers: { authorization: `Bearer ${init.token ?? TOKEN}`, "content-type": "application/json" },
            body: init.body === undefined ? null : JSON.stringify(init.body),
        });
    const listed = async () => PhoneKeyringsResultSchema.parse(await (await call(PHONE_PASSWORDS_PATHS.keyrings)).json()).keyrings;
    return { keyring, call, listed, tick: (ms: number) => void (clock += ms) };
};

const PHONE = { device: "pixel", label: "Pixel 8", seal: KEY, presence: "MFkwEwYHKoZIzj0CAQ" };
const ITEM = {
    origin: { kind: "package", package: "com.github.android" },
    sealed: { v: 1, epk: KEY, iv: "AAAAAAAAAAAAAAAA", tag: "A".repeat(22), data: "AAAA" },
    source: "phone",
    via: "Pixel 8",
    at: 5,
};

test("a token no phone holds is refused, and nothing reaches a keyring", async () => {
    const door = stand();
    expect((await door.call(PHONE_PASSWORDS_PATHS.keyrings, { token: "iph_nobody" })).status).toBe(401);
    expect((await door.call(PHONE_PASSWORDS_PATHS.pair, { method: "POST", token: "", body: { keyring: "rog", phone: PHONE } })).status).toBe(401);
    expect(door.keyring.calls).toEqual([]);
});

test("the keyrings list says where the phone may save, and a yes to a pairing is remembered as paired", async () => {
    const door = stand([computer("rog::wsl:archlinux"), computer("omen", { online: false, setUp: false, locked: undefined, inbox: undefined, remember: undefined })]);
    expect(await door.listed()).toEqual([
        { device: "rog::wsl:archlinux", label: "rog", online: true, locked: false, inbox: KEY, remember: true, paired: false },
        { device: "omen", label: "omen", online: false, remember: false, paired: false },
    ]);
    const paired = await door.call(PHONE_PASSWORDS_PATHS.pair, { method: "POST", body: { keyring: "rog::wsl:archlinux", phone: PHONE } });
    expect(await paired.json()).toEqual({ ok: true, fingerprint: "AB12" });
    expect((await door.listed()).map((keyring) => keyring.paired)).toEqual([true, false]);
});

test("a refused pairing is the keyring's answer as the body, and is not remembered", async () => {
    const door = stand();
    door.keyring.phonePair = async () => ({ ok: false, code: "declined", refusal: "the person said no" });
    const answer = await door.call(PHONE_PASSWORDS_PATHS.pair, { method: "POST", body: { keyring: "rog", phone: PHONE } });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: false, code: "declined", refusal: "the person said no" });
    expect((await door.listed())[0]?.paired).toBe(false);
});

test("the door carries the phone's own captures only, sealed as they came", async () => {
    const door = stand();
    const saved = await door.call(PHONE_PASSWORDS_PATHS.capture, { method: "POST", body: { keyring: "rog", item: ITEM } });
    expect(await saved.json()).toMatchObject({ ok: true, outcome: "saved" });
    expect(door.keyring.calls).toEqual([{ procedure: "keyringCapture", input: { ...ITEM, kind: "password" } }]);
    const posing = await door.call(PHONE_PASSWORDS_PATHS.capture, { method: "POST", body: { keyring: "rog", item: { ...ITEM, source: "browser" } } });
    expect(posing.status).toBe(400);
    const malformed = await door.call(PHONE_PASSWORDS_PATHS.capture, { method: "POST", body: { keyring: "rog" } });
    expect(malformed.status).toBe(400);
    expect(door.keyring.calls).toHaveLength(1);
});

test("fills are held to ten a minute per phone, and the bucket refills with time", async () => {
    const door = stand();
    const fill = () => door.call(PHONE_PASSWORDS_PATHS.fill, { method: "POST", body: { keyring: "rog", fill: { payload: "eyJ2IjoxfQ", sig: "MEUCIQ" } } });
    for (let n = 0; n < 10; n++) {
        expect((await fill()).status).toBe(200);
    }
    expect((await fill()).status).toBe(429);
    door.tick(6_000);
    expect((await fill()).status).toBe(200);
});
