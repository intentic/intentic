import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { sshHostname, zoneFromUrl } from "@intentic/sandbox-contract";

// Desktop enrollment for Mutagen: a machine lands its ed25519 public key here (redeeming a browser-minted
// pairing token), then Mutagen rides SSH with that key for two things — bidirectional FILE sync of /work, and
// TCP PORT mirroring of the sandbox's dev-server ports onto the machine's localhost. Trust roots in the Google
// identity that minted the pairing; the agent itself needs no OAuth, just the one-time token.
//
// The two uses have different multiplicity, so enrollment carries a MODE:
//   - "sync"   → file sync (+ mirroring). SINGLE-HOLDER: two machines two-way-syncing /work would race, so only
//                one sync enrollment exists at a time (a second needs an explicit takeover).
//   - "mirror" → port mirroring only. UNLIMITED: forwards are read-only and per-machine, so every collaborator
//                can mirror the sandbox's ports to their own localhost simultaneously.
// The owner can enroll either mode; a member (collaborator) can only ever get "mirror" — enforced at pairing
// mint, so the file-sync lock is owner-territory while live previews are everyone's.

export type SyncMode = "sync" | "mirror";

// One-time pairing tokens, in memory (ephemeral: a daemon restart just means the user clicks Enable again). Each
// carries the mode it may enroll — the browser card mints it per the requester's role, and the enroll trusts the
// pairing's mode, not anything the agent claims.
const PAIR_TTL_MS = 10 * 60 * 1000;
const pairings = new Map<string, { expiresAt: number; mode: SyncMode }>();

export const mintPairing = (mode: SyncMode): { token: string; expiresIn: number } => {
    const token = randomBytes(32).toString("base64url");
    pairings.set(token, { expiresAt: Date.now() + PAIR_TTL_MS, mode });
    return { token, expiresIn: Math.floor(PAIR_TTL_MS / 1000) };
};

// Seed a pre-agreed pairing: the platform-minted setup-time token connect.{sh,ps1} passes via container env
// (SYNC_PAIR_TOKEN), so the connect script's sync agent can enroll without a browser mint. It's the OWNER's
// setup-time token, so it seeds the full "sync" mode. Same TTL + single-use consumption as a minted one; the env
// persists on the container, so each restart re-arms it for PAIR_TTL_MS — same trust class as CONNECT_TOKEN.
export const seedPairing = (token: string): void => {
    pairings.set(token, { expiresAt: Date.now() + PAIR_TTL_MS, mode: "sync" });
};

// Valid = known + unexpired (prunes on expiry). Peek only — the caller consumes it after a successful enroll,
// so a failed enroll leaves the token usable for a retry.
export const isValidPairing = (token: string): boolean => pairingMode(token) !== undefined;

// The mode a pairing grants, or undefined when unknown/expired (prunes on expiry).
export const pairingMode = (token: string): SyncMode | undefined => {
    const pairing = pairings.get(token);
    if (pairing === undefined) {
        return undefined;
    }
    if (pairing.expiresAt < Date.now()) {
        pairings.delete(token);
        return undefined;
    }
    return pairing.mode;
};

export const consumePairing = (token: string): void => {
    pairings.delete(token);
};

// The enrollment store — source of truth for every desktop machine's key + sync token + mode, kept OUTSIDE
// /work (homedir, /root in the container) so the agent can't read the tokens. authorized_keys is DERIVED from
// it: every mutation rewrites the file, so sshd's view and this store never drift.
interface SyncEnrollment {
    // The authorized_keys line — the machine's identity (dedup key for re-enroll).
    readonly key: string;
    // sha256 of the machine's sync token (the raw token never touches disk).
    readonly tokenDigest: string;
    readonly mode: SyncMode;
    // The key line's comment field — the machine label for the UI.
    readonly machine: string;
    readonly enrolledAt: number;
}

const enrollmentsPath = (): string => join(homedir(), ".intentic-sync-enrollments.json");
const authorizedKeysPath = (): string => join(homedir(), ".ssh", "authorized_keys");
const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const machineOf = (key: string): string => key.trim().split(" ")[2] ?? "unknown";

const readEnrollments = async (): Promise<SyncEnrollment[]> => {
    try {
        return JSON.parse(await readFile(enrollmentsPath(), "utf8")) as SyncEnrollment[];
    } catch {
        return [];
    }
};

// Persist the store AND rewrite authorized_keys from it (one key line per enrollment) — the two always move
// together, so sshd authorizes exactly the enrolled machines.
const persist = async (enrollments: SyncEnrollment[]): Promise<void> => {
    await writeFile(enrollmentsPath(), JSON.stringify(enrollments), { mode: 0o600 });
    await mkdir(dirname(authorizedKeysPath()), { recursive: true, mode: 0o700 });
    await writeFile(authorizedKeysPath(), enrollments.map((entry) => entry.key).join("\n") + (enrollments.length > 0 ? "\n" : ""), { mode: 0o600 });
};

// One well-formed public key line: a known type, a base64 blob, an optional comment, and no embedded newline
// (so a caller can't smuggle extra authorized_keys entries or sshd directives).
const KEY_LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( \S+)?$/;

export const isValidAuthorizedKey = (key: string): boolean => !key.includes("\n") && KEY_LINE.test(key.trim());

// Enroll a machine's key in the given mode and mint its sync token. A "sync" enroll is single-holder: if a
// DIFFERENT machine already holds sync and this isn't a takeover, refuse (returns `{ locked }`); a takeover
// replaces that holder (dropping its key + token) while leaving every "mirror" enrollment untouched. A "mirror"
// enroll is always accepted and never disturbs anyone else. Re-enrolling the same machine rotates its token.
export const enrollSyncKey = async (args: { key: string; mode: SyncMode; takeover: boolean }): Promise<{ syncToken: string } | { locked: string }> => {
    const key = args.key.trim();
    const enrollments = await readEnrollments();
    if (args.mode === "sync") {
        const holder = enrollments.find((entry) => entry.mode === "sync" && entry.key !== key);
        if (holder !== undefined && !args.takeover) {
            return { locked: holder.machine };
        }
    }
    // Drop this machine's prior record (re-enroll rotates its token) and, for a sync enroll, any existing sync
    // holder (the takeover). Mirror enrollments always survive.
    const kept = enrollments.filter((entry) => entry.key !== key && !(args.mode === "sync" && entry.mode === "sync"));
    const token = `ist_${randomBytes(32).toString("base64url")}`;
    kept.push({ key, tokenDigest: digestOf(token), mode: args.mode, machine: machineOf(key), enrolledAt: Date.now() });
    await persist(kept);
    return { syncToken: token };
};

// Whether a presented sync token matches ANY enrollment — the /ports read credential + the self-revoke identity.
export const verifySyncToken = async (presented: string): Promise<boolean> => {
    const digest = Buffer.from(digestOf(presented));
    const enrollments = await readEnrollments();
    return enrollments.some((entry) => {
        const stored = Buffer.from(entry.tokenDigest);
        return stored.length === digest.length && timingSafeEqual(stored, digest);
    });
};

// Whether ANY machine is enrolled — the UI's "desktop sync/mirror active" signal.
export const isKeyEnrolled = async (): Promise<boolean> => (await readEnrollments()).length > 0;

// The machine holding file sync (there is at most one), for the "Syncing from X" card. Mirror-only machines
// aren't file-syncing, so they don't appear here.
export const syncHolder = async (): Promise<string | undefined> => (await readEnrollments()).find((entry) => entry.mode === "sync")?.machine;

// The machines currently mirroring ports (any number) — for the UI to show who has live previews.
export const mirrorMachines = async (): Promise<string[]> => (await readEnrollments()).filter((entry) => entry.mode === "mirror").map((entry) => entry.machine);

// Self-revoke: drop the enrollment owning this sync token (the agent's uninstall). Returns false when no
// enrollment matches (already gone). Rewrites authorized_keys, so the machine's SSH access dies with it.
export const revokeEnrollmentByToken = async (token: string): Promise<boolean> => {
    const digest = digestOf(token);
    const enrollments = await readEnrollments();
    const kept = enrollments.filter((entry) => entry.tokenDigest !== digest);
    if (kept.length === enrollments.length) {
        return false;
    }
    await persist(kept);
    return true;
};

// Owner "Disable desktop sync": drop EVERY enrollment (all keys + tokens) — the admin kill switch.
export const clearAllEnrollments = async (): Promise<void> => {
    await persist([]);
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
