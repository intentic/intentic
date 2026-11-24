import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Config } from "./config.js";

// Application-level encryption at rest for the few secrets the platform persists (Google OAuth tokens on
// Account, the sandbox connect token, setup payloads). AES-256-GCM; the effective key is the SHA-256 of
// SECRETS_KEY, so any sufficiently random string works as key material. Wire format:
// enc1:<iv>:<auth tag>:<ciphertext>, all base64url. SECRETS_KEY unset → values pass through as plaintext
// so unconfigured dev still boots (main.ts warns); production refuses to start without it (secretsKeyRefusal).
const PREFIX = `enc1:`;

// Why this process must not serve, or undefined when it may: production with no SECRETS_KEY would write every OAuth
// token, connect token and setup payload in plaintext. Production is NODE_ENV, as sign-in.ts and the log format read it.
// (2026-11-24) It was a warning alone, which a deploy that lost the variable would have logged and carried on past.
export const secretsKeyRefusal = (config: Pick<Config, "secrets">, env: NodeJS.ProcessEnv = process.env): string | undefined =>
    config.secrets.key === `` && env[`NODE_ENV`] === `production`
        ? `SECRETS_KEY is unset in production: refusing to start rather than store OAuth and sandbox tokens in plaintext`
        : undefined;

const keyOf = (config: Config): Buffer | undefined =>
    config.secrets.key === `` ? undefined : createHash(`sha256`).update(config.secrets.key).digest();

export const encryptSecret = (config: Config, value: string): string => {
    const key = keyOf(config);
    // Never double-encrypt: Better Auth account-update hooks can re-submit already-encrypted columns.
    if (!key || value.startsWith(PREFIX)) {
        return value;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv(`aes-256-gcm`, key, iv);
    const data = Buffer.concat([cipher.update(value, `utf8`), cipher.final()]);
    return `${PREFIX}${iv.toString(`base64url`)}:${cipher.getAuthTag().toString(`base64url`)}:${data.toString(`base64url`)}`;
};

export const decryptSecret = (config: Config, value: string): string => {
    // Plaintext rows only exist when SECRETS_KEY is unset (dev), fresh state, no migration path.
    if (!value.startsWith(PREFIX)) {
        return value;
    }
    const key = keyOf(config);
    if (!key) {
        throw new Error(`SECRETS_KEY is unset but an encrypted value was read`);
    }
    const [iv, tag, data] = value.slice(PREFIX.length).split(`:`);
    if (!iv || !tag || !data) {
        throw new Error(`malformed encrypted value`);
    }
    const decipher = createDecipheriv(`aes-256-gcm`, key, Buffer.from(iv, `base64url`));
    decipher.setAuthTag(Buffer.from(tag, `base64url`));
    return Buffer.concat([decipher.update(Buffer.from(data, `base64url`)), decipher.final()]).toString(`utf8`);
};
