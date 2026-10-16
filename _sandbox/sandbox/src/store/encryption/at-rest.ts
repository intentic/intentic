import { createHash, createDecipheriv, createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { AT_REST_KEY_FILE_ENV } from "@intentic/sandbox-contract";
import { isMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { z } from "zod";

export const AT_REST_PREVIOUS_KEY_FILE_ENV = "INTENTIC_AT_REST_PREVIOUS_KEY_FILE";
const MAGIC = "INTENTIC-ENC-v1:";
const EnvelopeSchema = z.object({ keyId: z.string(), iv: z.string(), tag: z.string(), data: z.string() });

export class AtRestKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AtRestKeyError";
    }
}

const keyFromFile = async (path: string): Promise<Buffer> => {
    const bytes = await readFile(path);
    if (bytes.length === 32) {return bytes;}
    const encoded = bytes.toString("utf8").trim();
    if (/^[0-9a-fA-F]{64}$/u.test(encoded)) {return Buffer.from(encoded, "hex");}
    if (/^[A-Za-z0-9+/]{43}=$/u.test(encoded) || /^[A-Za-z0-9+/]{44}$/u.test(encoded)) {
        const key = Buffer.from(encoded, "base64");
        if (key.length === 32) {return key;}
    }
    throw new AtRestKeyError(`at-rest key file ${path} must contain 32 raw bytes, 64 hex digits, or base64 of 32 bytes`);
};

const fingerprint = (key: Buffer): string => createHash("sha256").update(key).digest("hex").slice(0, 16);
const purposeKey = (key: Buffer, purpose: string): Buffer => Buffer.from(hkdfSync("sha256", key, "intentic-at-rest-v1", purpose, 32));

export const atRestActive = (): boolean => Boolean(process.env[AT_REST_KEY_FILE_ENV]);
// The keyring files are here so a key rotation re-seals them too: this sandbox's own keyring keys (which a keyring pinned,
// and a key lost with the old at-rest key would strand every share) and the copies a keyring keeps here.
export const AT_REST_STORES = [
    "sandbox-secrets.json",
    "capability-secrets.json",
    "extension-secrets.json",
    "privacy-vault.json",
    "keyring-keys.json",
    "keyring-copies.json",
] as const;
export const AT_REST_ACCOUNT_STORE = "provider-account-files";
export const isAtRestEnvelope = (text: string): boolean => text.startsWith(MAGIC);
const sameKey = (text: string, currentId: string): boolean => isAtRestEnvelope(text) && EnvelopeSchema.parse(JSON.parse(text.slice(MAGIC.length))).keyId === currentId;

const readDirectory = async (root: string) => readdir(root, { withFileTypes: true }).catch((error) => {
    if (isMissing(error)) {return [];}
    throw error;
});

const migrateAccounts = async (root: string, currentId: string): Promise<void> => {
    const directories = (await readDirectory(root)).filter((entry) => entry.isDirectory());
    const AccountSchema = z.object({ id: z.string(), connectedAt: z.number() });
    for (const directory of directories) {
        const dir = join(root, directory.name);
        const files = await readdir(dir, { withFileTypes: true });
        for (const entry of files.filter((file) => file.isFile() && file.name.endsWith(".json"))) {
            const id = entry.name.slice(0, -".json".length);
            const path = join(dir, entry.name);
            const text = await readFile(path, "utf8");
            const purpose = `provider-account:${basename(dir)}/${id}`;
            const plain = await decryptAtRest(text, purpose);
            if (sameKey(text, currentId)) {continue;}
            let account: unknown;
            try {
                account = JSON.parse(plain);
            } catch {
                continue;
            }
            if (AccountSchema.safeParse(account).data?.id !== id) {continue;}
            if (atRestActive()) {await writeFileAtomic(path, await encryptAtRest(plain, purpose), 0o600, { durable: true });}
        }
    }
};

export const migrateAtRestStores = async (root: string): Promise<void> => {
    const configured = process.env[AT_REST_KEY_FILE_ENV];
    if (!configured) {return;}
    const currentId = fingerprint(await keyFromFile(configured));
    for (const name of AT_REST_STORES) {
        const path = join(root, name);
        let text: string;
        try {
            text = await readFile(path, "utf8");
        } catch (error) {
            if (isMissing(error)) {continue;}
            throw error;
        }
        const plain = await decryptAtRest(text, name);
        if (!sameKey(text, currentId)) {await writeFileAtomic(path, await encryptAtRest(plain, name), 0o600, { durable: true });}
    }
    await migrateAccounts(root, currentId);
};

export const decryptAtRest = async (text: string, purpose: string): Promise<string> => {
    if (!isAtRestEnvelope(text)) {return text;}
    const currentPath = process.env[AT_REST_KEY_FILE_ENV];
    if (!currentPath) {throw new AtRestKeyError(`encrypted ${purpose} requires ${AT_REST_KEY_FILE_ENV}; refusing to read or replace it`);}
    let envelope: z.infer<typeof EnvelopeSchema>;
    try {
        envelope = EnvelopeSchema.parse(JSON.parse(text.slice(MAGIC.length)));
    } catch {
        throw new AtRestKeyError(`encrypted ${purpose} has an invalid envelope; refusing to replace it`);
    }
    for (const path of [currentPath, process.env[AT_REST_PREVIOUS_KEY_FILE_ENV]].filter((value): value is string => Boolean(value))) {
        const key = await keyFromFile(path);
        if (fingerprint(key) !== envelope.keyId) {continue;}
        try {
            const decipher = createDecipheriv("aes-256-gcm", purposeKey(key, purpose), Buffer.from(envelope.iv, "base64"));
            decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
            return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
        } catch {
            throw new AtRestKeyError(`encrypted ${purpose} failed authentication; refusing to read or replace it`);
        }
    }
    throw new AtRestKeyError(`encrypted ${purpose} needs its original key; set ${AT_REST_PREVIOUS_KEY_FILE_ENV} during rotation; refusing to replace it`);
};

export const encryptAtRest = async (text: string, purpose: string): Promise<string> => {
    const path = process.env[AT_REST_KEY_FILE_ENV];
    if (!path) {return text;}
    const key = await keyFromFile(path);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", purposeKey(key, purpose), iv);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `${MAGIC}${JSON.stringify({ keyId: fingerprint(key), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") })}\n`;
};
