import { generateKeyPairSync } from "node:crypto";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { createPlatformIdentityKey, type StoredIdentityKey } from "./platform-identity-key.js";

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

// The file on /history as the key sees it, in memory: what it holds, and every key written to it, in order.
const keptKey = (held?: string): StoredIdentityKey & { readonly written: string[] } => {
    const written: string[] = [];
    let file = held;
    return {
        read: async () => file,
        write: async (pem) => {
            written.push(pem);
            file = pem;
        },
        written,
    };
};

// Lets the boot read of the kept key land, as a real file read does before the first sign-in.
const landed = async (): Promise<void> => {
    for (let turn = 0; turn < 3; turn++) {
        // draining microtasks one turn at a time is the point
        await Promise.resolve();
    }
};

// A self-hosted daemon restarted while the platform is down must still verify an email-code sign-in: it reads the key
// its last announce taught from /history, and the env's key still wins at boot.
describe("the kept key", () => {
    it("is the key at boot when the env names none, and wakes a sign-in already waiting for one", async () => {
        const kept = ed25519();
        const key = createPlatformIdentityKey("", { stored: keptKey(kept) });
        const waiting = key.settled(10_000);
        await expect(waiting).resolves.toBe(kept);
        expect(key.current()).toBe(kept);
    });

    it("loses to the env's key at boot, and is not even read", async () => {
        const env = ed25519();
        const stored = keptKey(ed25519());
        const read = jest.spyOn(stored, "read");
        const key = createPlatformIdentityKey(env, { stored });
        await landed();
        expect(key.current()).toBe(env);
        expect(read).not.toHaveBeenCalled();
    });

    it("is replaced by a newer key an announce teaches, which is written once however often it is announced", async () => {
        const old = ed25519();
        const rotated = ed25519();
        const stored = keptKey(old);
        const key = createPlatformIdentityKey("", { stored });
        await landed();
        // The hourly announce names the key the file already holds: nothing is written.
        key.learn(old);
        key.learn(rotated);
        key.learn(rotated);
        await landed();
        expect(key.current()).toBe(rotated);
        expect(stored.written).toEqual([rotated]);
        expect(await stored.read()).toBe(rotated);
    });

    it("is written from an announce even while the env's key is the one in use", async () => {
        const env = ed25519();
        const stored = keptKey();
        createPlatformIdentityKey(env, { stored }).learn(env);
        await landed();
        expect(stored.written).toEqual([env]);
    });

    it("never overrides a key an announce taught before the boot read landed", async () => {
        const kept = ed25519();
        const announced = ed25519();
        const key = createPlatformIdentityKey("", { stored: keptKey(kept) });
        key.learn(announced);
        await landed();
        expect(key.current()).toBe(announced);
    });

    it("is no key when the file holds something that is not an Ed25519 public key", async () => {
        const key = createPlatformIdentityKey("", { stored: keptKey(rsa()) });
        await landed();
        expect(key.current()).toBeUndefined();
    });

    it("leaves the key in memory when the file cannot be read or written, and says so", async () => {
        const warn = jest.fn();
        const announced = ed25519();
        const broken: StoredIdentityKey = {
            read: async () => {
                throw new Error("EACCES: permission denied");
            },
            write: async () => {
                throw new Error("ENOSPC: no space left on device");
            },
        };
        const key = createPlatformIdentityKey("", { stored: broken, logger: { warn } });
        await landed();
        key.learn(announced);
        await landed();
        expect(key.current()).toBe(announced);
        expect(warn.mock.calls.map(([, message]) => message)).toEqual([
            "the platform's identity key kept on /history could not be read",
            "the platform's identity key was not kept on /history",
        ]);
    });
});
