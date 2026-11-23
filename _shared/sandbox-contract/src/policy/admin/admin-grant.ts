import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import type { KeyringKeyPair } from "../keyring-seal.js";

/* A SANDBOX'S YES TO ONE COMMAND RUN AS ADMINISTRATOR (2026-11-23). run_command's `admin` runs a command through
   intentic-remoted's Windows service, which starts it with the signed-in person's administrator token and no UAC prompt.
   The service runs one only with a grant the sandbox signed once the owner's card was answered (or the conversation's
   auto-approve mark answered it), checked against the sandbox signing keys pinned when the service was installed with an
   administrator's yes: a program of the person's can reach the service's pipe, but cannot sign a grant, so the service
   is no silent way to administrator for anything else on that computer.

   The key is the sandbox's keyring signing pair (secrets/device/keyring-keys.ts, published at GET /keyring/keys), under
   a domain of its own so a keyring grant can never be read as this one, or this one as a keyring grant. The grant names
   the command by its SHA-256 alone; the service also holds the PowerShell invocation around it to the one the machine
   agent makes, so nothing else rides on it. One use (its nonce), five minutes at most. intentic-remoted's
   `src/service/admin.rs` verifies exactly these bytes. */

export const ADMIN_GRANT_DOMAIN = "intentic-admin-run/grant/v1\0";
export const ADMIN_GRANT_TTL_MS = 5 * 60_000;

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export const AdminRunGrantSchema = z.object({
    kind: z.literal("admin-run"),
    commandSha256: z.string().regex(/^[0-9a-f]{64}$/u).describe("The command's SHA-256, lowercase hex, over its UTF-8 text."),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u).describe("16 random bytes, base64url: a grant runs once."),
    issuedAt: z.int(),
    expiresAt: z.int(),
});
export type AdminRunGrant = z.infer<typeof AdminRunGrantSchema>;

export const SignedAdminRunGrantSchema = z.object({
    payload: z.string().regex(BASE64URL).max(4096).describe("The grant's JSON, base64url."),
    sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/u).describe("The sandbox's Ed25519 signature over the domain and the payload, base64url."),
});
export type SignedAdminRunGrant = z.infer<typeof SignedAdminRunGrantSchema>;

/** The command's digest a grant names. Pure. */
export const commandSha256 = (command: string): string => createHash("sha256").update(command, "utf8").digest("hex");

const signedBytes = (payload: Buffer): Buffer => Buffer.concat([Buffer.from(ADMIN_GRANT_DOMAIN, "utf8"), payload]);

/** Signs a grant for `command` with the sandbox's signing pair, living `ttlMs` from `nowMs`. */
export const signAdminGrant = (pair: KeyringKeyPair, command: string, nonce: string, nowMs: number, ttlMs: number = ADMIN_GRANT_TTL_MS): SignedAdminRunGrant => {
    if (ttlMs <= 0 || ttlMs > ADMIN_GRANT_TTL_MS) {
        throw new Error(`an administrator grant lives at most ${String(ADMIN_GRANT_TTL_MS / 1000)} s`);
    }
    const body = AdminRunGrantSchema.parse({ kind: "admin-run", commandSha256: commandSha256(command), nonce, issuedAt: nowMs, expiresAt: nowMs + ttlMs });
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: pair.publicKey, d: pair.privateKey }, format: "jwk" });
    return { payload: payload.toString("base64url"), sig: sign(null, signedBytes(payload), key).toString("base64url") };
};

/** Whether `signed` is the holder of `publicKey`'s grant for `command`, live at `nowMs`. The service's own check, for tests and tools. */
export const adminGrantHolds = (publicKey: string, signed: SignedAdminRunGrant, command: string, nowMs: number): boolean => {
    const payload = Buffer.from(signed.payload, "base64url");
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    if (!verify(null, signedBytes(payload), key, Buffer.from(signed.sig, "base64url"))) {
        return false;
    }
    const grant = AdminRunGrantSchema.safeParse(JSON.parse(payload.toString("utf8")));
    return (
        grant.success &&
        grant.data.commandSha256 === commandSha256(command) &&
        grant.data.expiresAt > grant.data.issuedAt &&
        grant.data.expiresAt - grant.data.issuedAt <= ADMIN_GRANT_TTL_MS &&
        nowMs <= grant.data.expiresAt
    );
};
