import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isMissing } from "@intentic/base/errors";
import { writeSecretFile } from "@intentic/local-agent";
import {
    KEYRING_KEY_RE,
    KeyringInboxItemSchema,
    KeyringPublicKeySchema,
    KeyringSecretNameSchema,
    KeyringSourceSchema,
    KeyringSyncItemSchema,
    KeyringSyncPeerSchema,
    SealedBoxSchema,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { BackendConfigSchema, BackendRefSchema, EntryInfoSchema, EntryRulesSchema, ShareInfoSchema } from "./protocol.js";

// THE VAULT FILE, `vault.json`. One random 32-byte vault key seals the inner document (every entry with its value, the
// inbox and sync private keys, the sandboxes' keys as they were pinned, the paired keyrings, the password managers'
// settings) under AES-256-GCM. The key itself is stored only wrapped, once per way of unlocking: under a key scrypt
// derives from the passphrase; under one HKDF derives from a Windows Hello signature over a fixed challenge (Hello signs
// with an RSA key held by the TPM, PKCS#1 v1.5, which is deterministic: the same challenge always gives the same
// signature, and only a Hello gesture produces one); and in hardened mode under DPAPI for the service's own account.
//
// Beside the sealed part sits an OPEN part, readable while locked: a copy of what the inner document says about names and
// rules (so `list` and `shares` answer while locked, never with a value), the copies already sealed to their sandboxes,
// and what arrived while locked (inbox and sync items, sealed to keys only the inner document holds). A process of this
// user can rewrite the open part; nothing that hands out a value reads it, only the inner document, which it cannot.

const VAULT_AAD = Buffer.from("intentic-keyring/vault/v1", "utf8");
const HELLO_INFO = Buffer.from("intentic-keyring/hello/v1", "utf8");
const wrapAad = (method: string): Buffer => Buffer.from(`intentic-keyring/wrap/v1/${method}`, "utf8");

// scrypt at N=2^17, r=8, p=1: 128 MiB and about half a second per try, which is what makes a stolen vault file slow
// to guess at. Kept in each wrap, so a vault written with other figures (a test's) opens with its own.
export const SCRYPT_COST = { N: 2 ** 17, r: 8, p: 1 } as const;
export interface ScryptCost {
    readonly N: number;
    readonly r: number;
    readonly p: number;
}
// What scrypt needs is 128 * N * r bytes; Node refuses anything over its maxmem, whose default (32 MiB) is less.
const scryptMaxmem = (cost: ScryptCost): number => 128 * cost.N * cost.r + 64 * 1024 * 1024;

export const VAULT_KEY_BYTES = 32;
// The longest value an entry holds, in bytes: a released value must fit one sealed box (schemas/keyring.ts), with room
// for a sync item to carry it beside its rules.
export const VALUE_MAX_BYTES = 32 * 1024;

const b64u = z.string().regex(/^[A-Za-z0-9_-]*$/u);
const BoxSchema = z.object({ iv: b64u, tag: b64u, data: b64u }).strict();
export type Box = z.infer<typeof BoxSchema>;

const PassphraseWrapSchema = BoxSchema.extend({
    method: z.literal("passphrase"),
    salt: b64u,
    N: z.number().int().min(2 ** 10).max(2 ** 20),
    r: z.number().int().min(1).max(32),
    p: z.number().int().min(1).max(16),
}).strict();
const HelloWrapSchema = BoxSchema.extend({
    method: z.literal("hello"),
    // The KeyCredentialManager credential that signs: `intentic-keyring-<user hash>`.
    credential: z.string().min(1).max(128),
    challenge: b64u,
    // Its public key as Hello returned it (X.509 SubjectPublicKeyInfo, DER, base64), what hardened mode pins.
    publicKey: z.string().regex(/^[A-Za-z0-9+/=]+$/u).max(4096).optional(),
}).strict();
const DpapiWrapSchema = z
    .object({
        method: z.literal("dpapi"),
        // The vault key under DPAPI for the service's account (service/dpapi.ts), base64.
        blob: z.string().regex(/^[A-Za-z0-9+/=]+$/u).max(8192),
    })
    .strict();
export const WrapSchema = z.discriminatedUnion("method", [PassphraseWrapSchema, HelloWrapSchema, DpapiWrapSchema]);
export type Wrap = z.infer<typeof WrapSchema>;
export type HelloWrap = z.infer<typeof HelloWrapSchema>;

export const KeyPairSchema = z.object({ publicKey: z.string().regex(KEYRING_KEY_RE), privateKey: z.string().regex(KEYRING_KEY_RE) }).strict();

// A sandbox's keys as the keyring fetched them from its own address when an entry was first shared with it.
export const SandboxPinSchema = z.object({ sign: KeyringPublicKeySchema, seal: KeyringPublicKeySchema, fetchedAt: z.number() }).strict();
export type SandboxPin = z.infer<typeof SandboxPinSchema>;

export const StoredEntrySchema = z
    .object({
        name: KeyringSecretNameSchema,
        rules: EntryRulesSchema,
        source: KeyringSourceSchema,
        backend: BackendRefSchema.optional(),
        // Absent for a backed entry, read from its password manager at each use, and for a tombstone.
        value: z.string().optional(),
        shares: z.array(ShareInfoSchema),
        createdAt: z.number(),
        updatedAt: z.number(),
        // The vault's revision at the entry's last change.
        revision: z.number().int().nonnegative(),
        // Removed: kept as a name and a time so a paired keyring learns of the removal instead of sending it back.
        deleted: z.boolean().optional(),
    })
    .strict();
export type StoredEntry = z.infer<typeof StoredEntrySchema>;

export const VaultDocumentSchema = z
    .object({
        v: z.literal(1),
        // How many changes this keyring has made (KeyringSyncState.revision).
        revision: z.number().int().nonnegative(),
        entries: z.record(KeyringSecretNameSchema, StoredEntrySchema),
        inbox: KeyPairSchema,
        sync: KeyPairSchema,
        peers: z.array(KeyringSyncPeerSchema),
        backends: z.array(BackendConfigSchema),
        pins: z.record(z.string(), SandboxPinSchema),
        // The vault revision each paired keyring was last sent, by its sync key: a change past it is sent next time.
        syncSent: z.record(KeyringPublicKeySchema, z.number().int().min(-1)).optional(),
    })
    .strict();
export type VaultDocument = z.infer<typeof VaultDocumentSchema>;

const CopySchema = z.object({ name: KeyringSecretNameSchema, sealed: SealedBoxSchema, updatedAt: z.number() }).strict();
export type SealedCopy = z.infer<typeof CopySchema>;

export const PendingInboxSchema = z.object({ item: KeyringInboxItemSchema, receivedAt: z.number() }).strict();
export type PendingInbox = z.infer<typeof PendingInboxSchema>;

// How many items wait at most; past it the oldest go, so a sandbox cannot fill the disk while the vault is locked.
export const PENDING_INBOX_MAX = 32;
export const PENDING_SYNC_MAX = 128;

export const OpenPartSchema = z
    .object({
        entries: z.array(EntryInfoSchema),
        backends: z.array(z.enum(["1password", "bitwarden", "keepassxc"])),
        peers: z.array(KeyringSyncPeerSchema),
        revision: z.number().int().nonnegative(),
        copies: z.record(z.string(), z.array(CopySchema)),
        pendingInbox: z.array(PendingInboxSchema).max(PENDING_INBOX_MAX),
        pendingSync: z.array(KeyringSyncItemSchema).max(PENDING_SYNC_MAX),
    })
    .strict();
export type OpenPart = z.infer<typeof OpenPartSchema>;

export const VaultFileSchema = z
    .object({
        v: z.literal(1),
        wraps: z.array(WrapSchema).min(1),
        sealed: BoxSchema,
        open: OpenPartSchema,
    })
    .strict();
export type VaultFile = z.infer<typeof VaultFileSchema>;

export class VaultError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "VaultError";
    }
}

export const newVaultKey = (): Buffer => randomBytes(VAULT_KEY_BYTES);

const sealBox = (key: Buffer, plaintext: Buffer, aad: Buffer): Box => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") };
};

// Undefined for any box that does not open under `key` for `aad`: the wrong passphrase reads exactly like this.
const openBox = (key: Buffer, box: Box, aad: Buffer): Buffer | undefined => {
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64url"));
        decipher.setAAD(aad);
        decipher.setAuthTag(Buffer.from(box.tag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(box.data, "base64url")), decipher.final()]);
    } catch {
        // allow(silent-catch): GCM says only "does not authenticate", which is the one answer a wrong key gets
        return undefined;
    }
};

export const sealDocument = (key: Buffer, document: VaultDocument): Box => sealBox(key, Buffer.from(JSON.stringify(VaultDocumentSchema.parse(document)), "utf8"), VAULT_AAD);

export const openDocument = (key: Buffer, box: Box): VaultDocument => {
    const plain = openBox(key, box, VAULT_AAD);
    if (plain === undefined) {
        throw new VaultError("The vault does not open with this key: the file was changed or belongs to another keyring.");
    }
    const parsed = VaultDocumentSchema.safeParse(JSON.parse(plain.toString("utf8")));
    if (!parsed.success) {
        throw new VaultError("The vault opened but holds something this keyring does not read: is it a newer version's?");
    }
    return parsed.data;
};

const deriveFromPassphrase = async (passphrase: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> =>
    await new Promise((resolve, reject) => {
        scrypt(passphrase.normalize("NFC"), salt, VAULT_KEY_BYTES, { N: cost.N, r: cost.r, p: cost.p, maxmem: scryptMaxmem(cost) }, (error, derived) =>
            // Bun answers a success with `undefined` where Node says `null`: only an Error is a failure.
            error instanceof Error ? reject(error) : resolve(derived),
        );
    });

export const wrapWithPassphrase = async (vaultKey: Buffer, passphrase: string, cost: ScryptCost = SCRYPT_COST): Promise<Wrap> => {
    const salt = randomBytes(16);
    const wrapKey = await deriveFromPassphrase(passphrase, salt, cost);
    return { method: "passphrase", salt: salt.toString("base64url"), N: cost.N, r: cost.r, p: cost.p, ...sealBox(wrapKey, vaultKey, wrapAad("passphrase")) };
};

// The vault key, or undefined when `passphrase` is not the one it was wrapped with.
export const unwrapPassphrase = async (wraps: readonly Wrap[], passphrase: string): Promise<Buffer | undefined> => {
    for (const wrap of wraps) {
        if (wrap.method === "passphrase") {
            // One wrap per method in practice; tried in order should a rewrap ever leave two.
            const wrapKey = await deriveFromPassphrase(passphrase, Buffer.from(wrap.salt, "base64url"), wrap);
            const key = openBox(wrapKey, wrap, wrapAad("passphrase"));
            if (key !== undefined) {
                return key;
            }
        }
    }
    return undefined;
};

export const helloChallenge = (): string => randomBytes(32).toString("base64url");

export const helloWrapKey = (signature: Buffer, challenge: string): Buffer =>
    Buffer.from(hkdfSync("sha256", signature, Buffer.from(challenge, "base64url"), HELLO_INFO, VAULT_KEY_BYTES));

export interface HelloEnrolment {
    readonly credential: string;
    readonly challenge: string;
    readonly signature: Buffer;
    readonly publicKey?: string;
}

export const wrapWithHello = (vaultKey: Buffer, enrolment: HelloEnrolment): Wrap => {
    const wrap: HelloWrap = {
        method: "hello",
        credential: enrolment.credential,
        challenge: enrolment.challenge,
        ...sealBox(helloWrapKey(enrolment.signature, enrolment.challenge), vaultKey, wrapAad("hello")),
    };
    return enrolment.publicKey === undefined ? wrap : { ...wrap, publicKey: enrolment.publicKey };
};

export const helloWrapOf = (wraps: readonly Wrap[]): HelloWrap | undefined => wraps.find((wrap): wrap is HelloWrap => wrap.method === "hello");

export const unwrapHello = (wrap: HelloWrap, signature: Buffer): Buffer | undefined => openBox(helloWrapKey(signature, wrap.challenge), wrap, wrapAad("hello"));

// Whether two vault keys are the same key, without a timing side channel to say how far they agree.
export const sameKey = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

export const emptyOpenPart = (): OpenPart => ({ entries: [], backends: [], peers: [], revision: 0, copies: {}, pendingInbox: [], pendingSync: [] });

// The vault file, or undefined before setup. A file that does not parse is an error: setting up over it would destroy
// whatever it held.
export const readVaultFile = async (path: string): Promise<VaultFile | undefined> => {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch (error) {
        if (isMissing(error)) {
            return undefined;
        }
        throw error;
    }
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (error) {
        throw new VaultError(`${path} is not JSON: restore it from a backup, or move it aside to set up a new keyring.`, { cause: error });
    }
    const parsed = VaultFileSchema.safeParse(json);
    if (!parsed.success) {
        throw new VaultError(`${path} is not a vault this keyring reads: is it a newer version's? Restore it from a backup, or move it aside to set up a new keyring.`);
    }
    return parsed.data;
};

export const writeVaultFile = async (path: string, dir: string, file: VaultFile): Promise<void> => {
    await writeSecretFile(path, dir, `${JSON.stringify(VaultFileSchema.parse(file))}\n`);
};
