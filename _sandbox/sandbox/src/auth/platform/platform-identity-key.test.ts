import { generateKeyPairSync } from "node:crypto";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { createPlatformIdentityKey } from "./platform-identity-key.js";

const ed25519 = (): string => generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey;
const rsa = (): string =>
    generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey;

afterEach(() => jest.useRealTimers());

describe("platform identity key", () => {
    it("starts from the machine env's key, and takes the newest the platform announces", () => {
        const first = ed25519();
        const rotated = ed25519();
        const key = createPlatformIdentityKey(first);
        expect(key.current()).toBe(first);
        key.learn(rotated);
        expect(key.current()).toBe(rotated);
    });

    it("ignores what is not an Ed25519 public key, keeping the last good one", () => {
        const good = ed25519();
        const key = createPlatformIdentityKey("not a key");
        expect(key.current()).toBeUndefined();
        key.learn(good);
        key.learn(rsa());
        key.learn("-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----\n");
        expect(key.current()).toBe(good);
    });

    it("lets a sign-in that arrives before the first announce wait for the key, and gives up after the wait", async () => {
        jest.useFakeTimers();
        const key = createPlatformIdentityKey("");
        const announced = ed25519();
        const waiting = key.settled(10_000);
        await advanceTimersByTimeAsync(3_000);
        key.learn(announced);
        await expect(waiting).resolves.toBe(announced);

        const never = createPlatformIdentityKey("").settled(10_000);
        await advanceTimersByTimeAsync(10_000);
        await expect(never).resolves.toBeUndefined();
    });
});
