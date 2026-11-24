import type { Config } from "./config.js";
import { decryptSecret, encryptSecret, secretsKeyRefusal } from "./crypto.js";

const withKey = { secrets: { key: `test-key-material` } } as Config;
const withoutKey = { secrets: { key: `` } } as Config;

describe(`crypto`, () => {
    it(`round-trips a value and never double-encrypts`, () => {
        const encrypted = encryptSecret(withKey, `tok-123`);
        expect(encrypted).toMatch(/^enc1:/);
        expect(encrypted).not.toContain(`tok-123`);
        expect(encryptSecret(withKey, encrypted)).toBe(encrypted);
        expect(decryptSecret(withKey, encrypted)).toBe(`tok-123`);
    });

    it(`passes plaintext through when SECRETS_KEY is unset`, () => {
        expect(encryptSecret(withoutKey, `tok-123`)).toBe(`tok-123`);
        expect(decryptSecret(withoutKey, `tok-123`)).toBe(`tok-123`);
    });

    it(`fails loudly on an encrypted value without a key or with a tampered payload`, () => {
        const encrypted = encryptSecret(withKey, `tok-123`);
        expect(() => decryptSecret(withoutKey, encrypted)).toThrow(/SECRETS_KEY/);
        expect(() => decryptSecret(withKey, `${encrypted.slice(0, -4)}AAAA`)).toThrow();
    });

    it(`refuses production without SECRETS_KEY, and nothing else`, () => {
        expect(secretsKeyRefusal(withoutKey, { NODE_ENV: `production` })).toBe(
            `SECRETS_KEY is unset in production: refusing to start rather than store OAuth and sandbox tokens in plaintext`,
        );
        expect(secretsKeyRefusal(withKey, { NODE_ENV: `production` })).toBeUndefined();
        expect(secretsKeyRefusal(withoutKey, { NODE_ENV: `development` })).toBeUndefined();
        expect(secretsKeyRefusal(withoutKey, {})).toBeUndefined();
    });
});
