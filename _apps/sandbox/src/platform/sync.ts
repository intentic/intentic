import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { sshHostname, zoneFromUrl } from "@intentic/sandbox-contract";

// Local-sync (Mutagen) enrollment. The owner mints a short-lived pairing token in the browser (POST
// /system/sync/pair, Google-authed); the desktop agent redeems it once at POST /system/authorized-key to land
// its ed25519 public key here, then Mutagen rides SSH with that key. So trust still roots in the owner's Google
// identity (which mints the token), but the agent itself needs no OAuth — just the one-time token.

// One-time pairing tokens, in memory (ephemeral: a daemon restart just means the user clicks Enable again).
const PAIR_TTL_MS = 10 * 60 * 1000;
const pairings = new Map<string, { expiresAt: number }>();

export const mintPairing = (): { token: string; expiresIn: number } => {
    const token = randomBytes(32).toString("base64url");
    pairings.set(token, { expiresAt: Date.now() + PAIR_TTL_MS });
    return { token, expiresIn: Math.floor(PAIR_TTL_MS / 1000) };
};

// Seed a pre-agreed pairing: the platform-minted setup-time token connect.{sh,ps1} passes via container env
// (SYNC_PAIR_TOKEN), so the connect script's sync agent can enroll without a browser mint. Same TTL + single-use
// consumption as a minted one. The env persists on the container, so each restart re-arms it for PAIR_TTL_MS —
// same trust class as CONNECT_TOKEN sitting in the same env.
export const seedPairing = (token: string): void => {
    pairings.set(token, { expiresAt: Date.now() + PAIR_TTL_MS });
};

// Valid = known + unexpired (prunes on expiry). Peek only — the caller consumes it after a successful enroll,
// so a failed enroll leaves the token usable for a retry.
export const isValidPairing = (token: string): boolean => {
    const pairing = pairings.get(token);
    if (pairing === undefined) {
        return false;
    }
    if (pairing.expiresAt < Date.now()) {
        pairings.delete(token);
        return false;
    }
    return true;
};

export const consumePairing = (token: string): void => {
    pairings.delete(token);
};

const authorizedKeysPath = (): string => join(homedir(), ".ssh", "authorized_keys");

// One well-formed public key line: a known type, a base64 blob, an optional comment, and no embedded newline
// (so a caller can't smuggle extra authorized_keys entries or sshd directives).
const KEY_LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( \S+)?$/;

export const isValidAuthorizedKey = (key: string): boolean => !key.includes("\n") && KEY_LINE.test(key.trim());

// Enroll the one desktop-sync key, overwriting any prior one: exactly one machine holds sync at a time (the
// daemon is the single choke point every agent enrolls against). Replacing a *different* machine's key is a
// takeover — the route gates that on an explicit header; this just writes the winner.
export const enrollAuthorizedKey = async (key: string): Promise<void> => {
    await mkdir(join(homedir(), ".ssh"), { recursive: true, mode: 0o700 });
    await writeFile(authorizedKeysPath(), `${key.trim()}\n`, { mode: 0o600 });
};

// The currently enrolled sync key line (the identity of the machine holding sync), or undefined if none.
export const currentSyncKey = async (): Promise<string | undefined> => {
    const existing = await readFile(authorizedKeysPath(), "utf8").catch(() => "");
    return existing
        .split("\n")
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
};

// Whether a desktop-sync key is enrolled — the UI's "desktop sync enabled" signal.
export const isKeyEnrolled = async (): Promise<boolean> => (await currentSyncKey()) !== undefined;

// The machine label of the current sync holder — the key line's comment field — for the "Syncing from X" UI.
export const syncingFrom = async (): Promise<string | undefined> => (await currentSyncKey())?.split(" ")[2];

// Revoke desktop sync: drop all enrolled keys (the UI's Disable). Removing the key halts Mutagen's SSH transport.
export const clearAuthorizedKeys = async (): Promise<void> => {
    await writeFile(authorizedKeysPath(), "", { mode: 0o600 }).catch(() => {});
};

// The sync token accompanying the enrolled key: the agent's credential for the ONE daemon route mirroring
// needs (GET /ports — see the bearer middleware). Minted fresh at every enrollment — so a takeover rotates it
// and the ousted machine's token dies with its key — and stored as a digest, sharing the key's lifetime and
// trust root (the owner-minted pairing). Raw tokens never touch disk.
const syncTokenDigestPath = (): string => join(homedir(), ".intentic-sync-token.digest");
const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

export const mintSyncToken = async (): Promise<string> => {
    const token = `ist_${randomBytes(32).toString("base64url")}`;
    await writeFile(syncTokenDigestPath(), digestOf(token), { mode: 0o600 });
    return token;
};

export const verifySyncToken = async (presented: string): Promise<boolean> => {
    const stored = (await readFile(syncTokenDigestPath(), "utf8").catch(() => "")).trim();
    if (stored === "") {
        return false;
    }
    const digest = digestOf(presented);
    return stored.length === digest.length && timingSafeEqual(Buffer.from(stored), Buffer.from(digest));
};

// Disable (DELETE /system/authorized-key) revokes the token alongside the key.
export const clearSyncToken = async (): Promise<void> => {
    await rm(syncTokenDigestPath(), { force: true });
};

// The SSH hostname the sandbox tunnel exposes for Mutagen — derived via sandboxIdFromToken (the same digest
// sandbox-tunnel.ts and preview-hostname.ts use), so the laptop can resolve it from the daemon without guessing.
// Undefined when the tunnel isn't configured (no connect token / no zone) — e.g. loopback or preview-only.
export const syncSshHostname = (connectToken: string, zone: string, publicUrl: string): string | undefined => {
    const resolvedZone = zone !== "" ? zone : zoneFromUrl(publicUrl);
    const id = sandboxIdFromToken(connectToken);
    if (id === undefined || resolvedZone === undefined || resolvedZone === "") {
        return undefined;
    }
    return sshHostname(id, resolvedZone);
};
