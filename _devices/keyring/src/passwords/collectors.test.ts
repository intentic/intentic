import { generateKeyPairSync, sign } from "node:crypto";
import { grantNonce, newSealKeyPair, unseal } from "@intentic/sandbox-contract/keyring-seal";
import type { KeyringPhoneFill, KeyringPhoneKeys } from "@intentic/sandbox-contract/schemas/keyring";
import { gitCredentialAnswer, parseGitCredential, runGitCredential } from "../git-credential/git-credential.js";
import { encodeNativeMessage, NativeFrames, NativeMessageTooLarge } from "../native-host/framing.js";
import { type Ask, answerNative } from "../native-host/native-host.js";
import { checkPhoneFill, presenceFingerprint } from "./phone.js";
import { fakeSandbox, type Harness, keyringHarness, TEST_PASSPHRASE } from "../testing.js";

// The ways a password reaches the vault from outside the app, each against a real keyring core: the browser
// extension's native-messaging host, git's credential helper, and the paired phone's autofill.

const setUp = async (): Promise<Harness> => {
    const h = keyringHarness([]);
    await h.keyring.handle({ op: "setup", passphrase: TEST_PASSPHRASE, hello: false });
    await h.keyring.handle({ op: "set-settings", patch: { remember: { browser: true, terminal: true, phone: true } } });
    h.person.asked.length = 0;
    return h;
};

// SAFETY: `handle` answers each request with that op's own response; its signature only widens it to the union.
const askOf = (h: Harness): Ask => async (request) => (await h.keyring.handle(request)) as never;

describe("the browser's native-messaging host", () => {
    test("frames survive arriving in pieces, and an oversized one is refused", () => {
        const frames = new NativeFrames();
        const bytes = Buffer.concat([encodeNativeMessage({ type: "undo", id: "1", ok: true }), encodeNativeMessage({ type: "never", id: "2", ok: true })]);
        expect(frames.push(bytes.subarray(0, 5))).toEqual([]);
        expect(frames.push(bytes.subarray(5)).map((text) => JSON.parse(text))).toEqual([
            { type: "undo", id: "1", ok: true },
            { type: "never", id: "2", ok: true },
        ]);
        const huge = Buffer.alloc(4);
        huge.writeUInt32LE(64 * 1024 * 1024, 0);
        expect(() => new NativeFrames().push(huge)).toThrow(NativeMessageTooLarge);
    });

    test("a sign-in is sealed before the pipe, kept, offered back by name, and filled only at a yes", async () => {
        const h = await setUp();
        const ask = askOf(h);
        expect(await answerNative({ type: "hello", id: "h", browser: "Brave" }, ask)).toMatchObject({ type: "hello", ok: true, setUp: true, remember: true });
        const captured = await answerNative({ type: "capture", id: "c", browser: "Brave", host: "GitHub.com", username: "radarsu", password: "github-password-1", title: "GitHub" }, ask);
        expect(captured).toMatchObject({ type: "capture", ok: true, outcome: "saved", name: "GITHUB" });
        expect(h.person.asked).toEqual([]);
        expect(await answerNative({ type: "candidates", id: "k", host: "github.com" }, ask)).toEqual({ type: "candidates", id: "k", ok: true, items: [{ name: "GITHUB", title: "GitHub", username: "radarsu" }] });
        expect(await answerNative({ type: "fill", id: "f", host: "github.com", name: "GITHUB" }, ask)).toEqual({ type: "fill", id: "f", ok: true, username: "radarsu", password: "github-password-1" });
        expect(h.person.asked).toHaveLength(1);
        // Another site's page cannot ask for it by name.
        expect(await answerNative({ type: "fill", id: "x", host: "evil.example", name: "GITHUB" }, ask)).toMatchObject({ type: "fill", ok: false });
    });

    test("Never for this site stops the next capture there", async () => {
        const h = await setUp();
        const ask = askOf(h);
        expect(await answerNative({ type: "never", id: "n", host: "bank.example" }, ask)).toEqual({ type: "never", id: "n", ok: true });
        expect(await answerNative({ type: "capture", id: "c", browser: "Brave", host: "bank.example", password: "bank-password-1" }, ask)).toMatchObject({ ok: true, outcome: "skipped" });
    });
});

describe("git's credential helper", () => {
    test("reads https remotes only, by host", () => {
        expect(parseGitCredential("protocol=https\nhost=github.com\npath=intentic/intentic.git\nusername=radarsu\n")).toEqual({ url: "https://github.com", username: "radarsu", password: undefined });
        expect(parseGitCredential("url=https://radar@gitlab.example/group/repo\npassword=pw\n")).toEqual({ url: "https://gitlab.example", username: "radar", password: "pw" });
        expect(parseGitCredential("protocol=ssh\nhost=github.com\n")).toBeUndefined();
        expect(gitCredentialAnswer("radarsu", "pw")).toBe("username=radarsu\npassword=pw\n");
    });

    test("store keeps a sign-in that worked, and get gives it back at a yes", async () => {
        const h = await setUp();
        const io = { warn: (): void => undefined, ask: askOf(h), now: () => h.clock.now };
        const written: string[] = [];
        expect(await runGitCredential("store", { ...io, input: "protocol=https\nhost=github.com\nusername=radarsu\npassword=git-token-123456\n", write: (text) => written.push(text) })).toBe(0);
        const listed = await h.keyring.handle({ op: "list" });
        expect(listed).toMatchObject({ ok: true, entries: [{ name: "GIT_GITHUB_COM", askpass: ["git:https://github.com"], hosts: ["github.com"] }] });
        // git sends `store` only after the value worked, so it is not left unverified.
        expect(JSON.stringify(listed)).not.toContain(`"unverified":true`);
        expect(await runGitCredential("get", { ...io, input: "protocol=https\nhost=github.com\n", write: (text) => written.push(text) })).toBe(0);
        expect(written).toEqual(["username=radarsu\npassword=git-token-123456\n"]);
    });
});

describe("the paired phone", () => {
    const phoneKeys = () => {
        const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
        const seal = newSealKeyPair();
        const keys: KeyringPhoneKeys = { device: "pixel-8", label: "Pixel 8", seal: seal.publicKey, presence: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
        const signer = (fill: KeyringPhoneFill) => {
            const payload = Buffer.from(JSON.stringify(fill), "utf8");
            return { payload: payload.toString("base64url"), sig: sign("sha256", payload, privateKey).toString("base64url") };
        };
        return { keys, signer, seal };
    };

    const fillAt = (now: number, over: Partial<KeyringPhoneFill> = {}): KeyringPhoneFill => ({
        v: 1,
        device: "pixel-8",
        origin: { kind: "package", package: "com.github.android" },
        nonce: grantNonce(),
        issuedAt: now,
        expiresAt: now + 60_000,
        ...over,
    });

    test("a fill request counts only when the pinned key signed it, recently and briefly", () => {
        const phone = phoneKeys();
        const pin = { keys: phone.keys, sandbox: "https://x.intentic.dev", pairedAt: 0 };
        const now = Date.now();
        expect(checkPhoneFill(phone.signer(fillAt(now)), pin, now)).toMatchObject({ ok: true });
        expect(checkPhoneFill(phoneKeys().signer(fillAt(now)), pin, now)).toMatchObject({ ok: false, code: "bad-grant" });
        expect(checkPhoneFill(phone.signer(fillAt(now - 120_000)), pin, now)).toMatchObject({ ok: false, code: "expired" });
        expect(checkPhoneFill(phone.signer(fillAt(now, { expiresAt: now + 10 * 60_000 })), pin, now)).toMatchObject({ ok: false, code: "bad-grant" });
        expect(checkPhoneFill(phone.signer(fillAt(now)), undefined, now)).toMatchObject({ ok: false, code: "not-shared" });
        expect(presenceFingerprint(phone.keys.presence)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/u);
    });

    test("paired at a yes, it fills sealed to its own key, once per request, with no prompt here", async () => {
        const h = await setUp();
        const sandbox = fakeSandbox().url;
        const phone = phoneKeys();
        const at = h.clock.now;
        const captured = await answerNative({ type: "capture", id: "c", browser: "Brave", host: "github.com", username: "radarsu", password: "github-password-1" }, askOf(h));
        expect(captured).toMatchObject({ ok: true, outcome: "saved" });
        expect(await h.keyring.handle({ op: "phone-pair", sandbox, phone: phone.keys })).toMatchObject({ ok: true });
        expect(h.person.asked.at(-1)?.message).toContain(presenceFingerprint(phone.keys.presence));
        const asked = h.person.asked.length;
        const signed = phone.signer(fillAt(at, { origin: { kind: "site", host: "github.com" } }));
        const answer = await h.keyring.handle({ op: "phone-fill", sandbox, fill: signed });
        if (!answer.ok || !("sealed" in answer)) {
            throw new Error(answer.ok ? "no value" : answer.refusal);
        }
        expect(h.person.asked).toHaveLength(asked);
        expect(JSON.stringify(answer)).not.toContain("github-password-1");
        const nonce: unknown = JSON.parse(Buffer.from(signed.payload, "base64url").toString("utf8")).nonce;
        expect(unseal(phone.seal, answer.sealed, { kind: "phone", device: "pixel-8", nonce: String(nonce) })).toBe("github-password-1");
        expect(await h.keyring.handle({ op: "phone-fill", sandbox, fill: signed })).toMatchObject({ ok: false, code: "replayed" });
    });
});
