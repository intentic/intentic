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

/* Seed a pre-agreed pairing: the platform-minted setup-time token connect.{sh,ps1} passes via container env
 * (SYNC_PAIR_TOKEN), so the connect script's sync agent can enroll without a browser mint. It's the OWNER's
 * setup-time token, so it seeds the full "sync" mode.
 *
 * SPENT ONCE, SPENT FOR GOOD. A browser-minted pairing dies with the daemon, but this one lives in the
 * container's environment, which is immortal by comparison: it is in the compose file, in `docker inspect`, in
 * whatever shell history ran the installer, and it is replayed verbatim into every rebuilt container. Re-arming
 * it on each boot therefore turned a setup-time token into a permanent key for /system/authorized-key — a route
 * exempt from the bearer middleware, whose reward is an SSH key in the container. One leak of the env, and
 * every future restart reopened the same ten-minute window.
 *
 * So the redemption is recorded on /history (which outlives the container, like the enrollments themselves) and
 * a consumed token never arms again. Re-running setup is unaffected: /setup/claim mints a FRESH token per
 * claim, so the ordinary "run the installer again" path seeds a digest nobody has burned. What no longer works
 * is replaying an already-redeemed token — which is exactly the capability that was worth removing. */
export const seedPairing = async (historyRoot: string, token: string): Promise<void> => {
    if (await isSeedConsumed(historyRoot, token)) {
        return;
    }
    pairings.set(token, { expiresAt: Date.now() + PAIR_TTL_MS, mode: "sync" });
    seeded.add(token);
};

// The setup-time tokens armed this boot — so consumePairing knows which redemptions are worth persisting. A
// browser-minted pairing is not in here: it is already unreplayable, because nothing outside memory holds it.
const seeded = new Set<string>();

const seedConsumedPath = (historyRoot: string): string => join(historyRoot, "sync-pair-consumed.json");

const readConsumed = async (historyRoot: string): Promise<string[]> => {
    try {
        const parsed = JSON.parse(await readFile(seedConsumedPath(historyRoot), "utf8")) as { digests?: unknown };
        return Array.isArray(parsed.digests) ? parsed.digests.filter((digest): digest is string => typeof digest === "string") : [];
    } catch {
        return [];
    }
};

// Digests, never the tokens: this file records that something was spent, and needs to hold nothing that could
// spend anything.
const isSeedConsumed = async (historyRoot: string, token: string): Promise<boolean> => (await readConsumed(historyRoot)).includes(digestOf(token));

const recordSeedConsumed = async (historyRoot: string, token: string): Promise<void> => {
    const digests = await readConsumed(historyRoot);
    const digest = digestOf(token);
    if (digests.includes(digest)) {
        return;
    }
    await mkdir(historyRoot, { recursive: true });
    await writeFile(seedConsumedPath(historyRoot), JSON.stringify({ digests: [...digests, digest] }), { mode: 0o600 });
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

// Redeem a pairing. A browser-minted one just leaves memory; a SEEDED one (the setup-time SYNC_PAIR_TOKEN) is
// also written to the /history burn list, so the copy still sitting in the container's env is inert from here on.
export const consumePairing = async (historyRoot: string, token: string): Promise<void> => {
    pairings.delete(token);
    if (seeded.delete(token)) {
        await recordSeedConsumed(historyRoot, token);
    }
};

// The enrollment store — source of truth for every desktop machine's key + sync token + mode. It lives on the
// /history volume: outside /work (so the agent can never read the tokens) AND outside the container's own
// filesystem, so it survives the `docker rm -f` + `docker run` that every rebuild path performs. It used to sit
// in homedir (/root), which a recreate wipes — taking every enrollment with it, so the laptop's key was no
// longer authorized and its sync token no longer verified, while its Mutagen session retried forever against a
// door that would never open again.
//
// authorized_keys is DERIVED from the store rather than stored alongside it: sshd reads a fixed path under
// ~/.ssh, which is container-local and ephemeral. Every mutation rewrites it, and restoreAuthorizedKeys()
// re-derives it at boot, so sshd's view and this store never drift.
interface SyncEnrollment {
    // The authorized_keys line — the machine's identity (dedup key for re-enroll).
    readonly key: string;
    // sha256 of the machine's sync token (the raw token never touches disk).
    readonly tokenDigest: string;
    readonly mode: SyncMode;
    // The key line's comment field — the machine label for the UI.
    readonly machine: string;
    readonly enrolledAt: number;
    // When this machine last USED its enrollment (see verifySyncToken). Absent until the first poll — an
    // enrollment that has never been used is exactly what a machine that never finished setup leaves behind.
    readonly seenAt?: number;
}

const enrollmentsPath = (historyRoot: string): string => join(historyRoot, "sync-enrollments.json");
const authorizedKeysPath = (): string => join(homedir(), ".ssh", "authorized_keys");
const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const machineOf = (key: string): string => key.trim().split(" ")[2] ?? "unknown";

const readEnrollments = async (historyRoot: string): Promise<SyncEnrollment[]> => {
    try {
        return JSON.parse(await readFile(enrollmentsPath(historyRoot), "utf8")) as SyncEnrollment[];
    } catch {
        return [];
    }
};

// Write authorized_keys from the store (one key line per enrollment), so sshd authorizes exactly the enrolled
// machines. An empty store writes an empty file rather than removing it — "nobody is enrolled" must be a state
// sshd can read, not an absence that a leftover file could contradict.
const writeAuthorizedKeys = async (enrollments: readonly SyncEnrollment[]): Promise<void> => {
    await mkdir(dirname(authorizedKeysPath()), { recursive: true, mode: 0o700 });
    await writeFile(authorizedKeysPath(), enrollments.map((entry) => entry.key).join("\n") + (enrollments.length > 0 ? "\n" : ""), { mode: 0o600 });
};

// Persist the store AND rewrite authorized_keys from it — the two always move together.
const persist = async (historyRoot: string, enrollments: SyncEnrollment[]): Promise<void> => {
    await mkdir(historyRoot, { recursive: true });
    await writeFile(enrollmentsPath(historyRoot), JSON.stringify(enrollments), { mode: 0o600 });
    await writeAuthorizedKeys(enrollments);
};

// Boot: re-derive the ephemeral authorized_keys from the store that outlived the container. Without this a
// recreate leaves every enrollment intact but nothing for sshd to authorize them against, so the laptop's key
// is refused until the next enroll happens to rewrite the file.
export const restoreAuthorizedKeys = async (historyRoot: string): Promise<void> => {
    await writeAuthorizedKeys(await readEnrollments(historyRoot));
};

// One well-formed public key line: a known type, a base64 blob, an optional comment, and no embedded newline
// (so a caller can't smuggle extra authorized_keys entries or sshd directives).
const KEY_LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( \S+)?$/;

export const isValidAuthorizedKey = (key: string): boolean => !key.includes("\n") && KEY_LINE.test(key.trim());

// Enroll a machine's key in the given mode and mint its sync token. A "sync" enroll is single-holder: if a
// DIFFERENT machine already holds sync and this isn't a takeover, refuse (returns `{ locked }`); a takeover
// replaces that holder (dropping its key + token) while leaving every "mirror" enrollment untouched. A "mirror"
// enroll is always accepted and never disturbs anyone else. Re-enrolling the same machine rotates its token.
export const enrollSyncKey = async (args: {
    historyRoot: string;
    key: string;
    mode: SyncMode;
    takeover: boolean;
}): Promise<{ syncToken: string } | { locked: string }> => {
    const key = args.key.trim();
    const enrollments = await readEnrollments(args.historyRoot);
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
    await persist(args.historyRoot, kept);
    return { syncToken: token };
};

/* How stale a seenAt may get before a verification refreshes it. The desktop agent's mirror watcher polls /ports
 * every 5 seconds per pairing and every poll lands here, so stamping each one would be a disk write every 5
 * seconds per machine, forever — to answer a question ("is that machine still syncing?") whose useful resolution
 * is minutes. Throttled, a live holder's seenAt is never more than this far behind. */
const SEEN_THROTTLE_MS = 60_000;

/* Whether a presented sync token matches ANY enrollment — the /ports read credential + the self-revoke identity.
 *
 * AND the heartbeat. The agent's ports poll is the one thing a live desktop sync does on its own, every few
 * seconds, so verification is where "this machine is still there" is knowable; nothing else on either end ever
 * asked. Without it an enrollment reads as active from the moment it is made until someone revokes it, so the
 * Desktop-sync card kept claiming "Syncing from <machine>" long after that machine had stopped — which is what a
 * folder silently losing its pairing looks like from the sandbox side, and why it took days to notice.
 *
 * The write goes through persist(), which also rewrites authorized_keys: the key set is unchanged by construction
 * here, and keeping the two coupled is worth more than skipping one small write a minute. A concurrent poll from
 * another machine can lose this stamp to a read-modify-write race; the next poll re-stamps it seconds later. */
export const verifySyncToken = async (historyRoot: string, presented: string): Promise<boolean> => {
    const digest = Buffer.from(digestOf(presented));
    const enrollments = await readEnrollments(historyRoot);
    const matched = enrollments.find((entry) => {
        const stored = Buffer.from(entry.tokenDigest);
        return stored.length === digest.length && timingSafeEqual(stored, digest);
    });
    if (matched === undefined) {
        return false;
    }
    const now = Date.now();
    if (matched.seenAt === undefined || now - matched.seenAt >= SEEN_THROTTLE_MS) {
        await persist(
            historyRoot,
            // oxlint-disable-next-line oxc/no-map-spread -- an enrollment is readonly; a fresh record for the one machine that polled is the point
            enrollments.map((entry) => (entry === matched ? { ...entry, seenAt: now } : entry)),
        );
    }
    return true;
};

// Whether ANY machine is enrolled — the UI's "desktop sync/mirror active" signal.
export const isKeyEnrolled = async (historyRoot: string): Promise<boolean> => (await readEnrollments(historyRoot)).length > 0;

// The machine holding file sync, as the card needs it: its label plus when it was last heard from. A projection
// rather than the enrollment itself — the record next to these two fields is a key and a token digest, which have
// no business reaching a browser.
export interface SyncHolder {
    readonly machine: string;
    readonly seenAt?: number;
}

// The machine holding file sync (there is at most one), for the "Syncing from X" card. Mirror-only machines
// aren't file-syncing, so they don't appear here.
export const syncHolder = async (historyRoot: string): Promise<SyncHolder | undefined> => {
    const holder = (await readEnrollments(historyRoot)).find((entry) => entry.mode === "sync");
    if (holder === undefined) {
        return undefined;
    }
    return { machine: holder.machine, ...(holder.seenAt === undefined ? {} : { seenAt: holder.seenAt }) };
};

// The machines currently mirroring ports (any number) — for the UI to show who has live previews.
export const mirrorMachines = async (historyRoot: string): Promise<string[]> =>
    (await readEnrollments(historyRoot)).filter((entry) => entry.mode === "mirror").map((entry) => entry.machine);

// Self-revoke: drop the enrollment owning this sync token (the agent's uninstall). Returns false when no
// enrollment matches (already gone). Rewrites authorized_keys, so the machine's SSH access dies with it.
export const revokeEnrollmentByToken = async (historyRoot: string, token: string): Promise<boolean> => {
    const digest = digestOf(token);
    const enrollments = await readEnrollments(historyRoot);
    const kept = enrollments.filter((entry) => entry.tokenDigest !== digest);
    if (kept.length === enrollments.length) {
        return false;
    }
    await persist(historyRoot, kept);
    return true;
};

// Owner "Disable desktop sync": drop EVERY enrollment (all keys + tokens) — the admin kill switch.
export const clearAllEnrollments = async (historyRoot: string): Promise<void> => {
    await persist(historyRoot, []);
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
