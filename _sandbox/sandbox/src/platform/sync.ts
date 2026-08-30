import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MachineReport } from "@intentic/sandbox-contract";
import { publishRuntimeChange } from "../system/runtime-watch.js";

// Desktop enrollment for Mutagen: a machine lands its ed25519 public key here (redeeming a browser-minted
// pairing token), then Mutagen rides SSH with that key for two things, bidirectional FILE sync of /work, and
// TCP PORT mirroring of the sandbox's dev-server ports onto the machine's localhost. Trust roots in the Google
// identity that minted the pairing; the agent itself needs no OAuth, just the one-time token.
//
// The two uses have different multiplicity, so enrollment carries a MODE:
//   - "sync"   → file sync (+ mirroring). SINGLE-HOLDER: two machines two-way-syncing /work would race, so only
//                one sync enrollment exists at a time (a second needs an explicit takeover).
//   - "mirror" → port mirroring only. UNLIMITED: forwards are read-only and per-machine, so every collaborator
//                can mirror the sandbox's ports to their own localhost simultaneously.
// The owner can enroll either mode; a member (collaborator) can only ever get "mirror", enforced at pairing
// mint, so the file-sync lock is owner-territory while live previews are everyone's.

export type SyncMode = "sync" | "mirror";

/* THE PAIRING HALF IS store/enrollment.ts's, shared with the three doors that enroll the same way, and held on
 * `services.syncPairings` because that is where the history root is known. It used to be a module-global map
 * with a hand-rolled burn file beside it, which is how this door was still writing /history with a bare
 * `writeFile` — the truncate-then-fill that json-file.ts exists to rule out — long after every other store had
 * moved onto that substrate.
 *
 * What travels on a sync pairing is the MODE it may enroll, because the two uses have different multiplicity
 * (above) and the mint is the last point at which the requester's role is known: the browser card mints per
 * role, and the enroll trusts the pairing's mode rather than anything the agent claims. The setup-time token
 * connect.{sh,ps1} passes in the container env is ARMED rather than minted (main.ts) — it is the owner's, so it
 * arms the full "sync" mode, and it is replayable, which is the entire reason this door has a burn file.
 *
 * Unlike the other three, this enroll peeks and consumes SEPARATELY rather than redeeming in one call: landing
 * a key is fallible (the single-holder lock can refuse it), and a refusal has to leave the token usable for the
 * retry that carries --takeover. */
export const syncPairBurnPath = (historyRoot: string): string => join(historyRoot, "sync-pair-consumed.json");

// The enrollment store, source of truth for every desktop machine's key + sync token + mode. It lives on the
// /history volume: outside /work (so the agent can never read the tokens) AND outside the container's own
// filesystem, so it survives the `docker rm -f` + `docker run` that every rebuild path performs. It used to sit
// in homedir (/root), which a recreate wipes, taking every enrollment with it, so the laptop's key was no
// longer authorized and its sync token no longer verified, while its Mutagen session retried forever against a
// door that would never open again.
//
// authorized_keys is DERIVED from the store rather than stored alongside it: sshd reads a fixed path under
// ~/.ssh, which is container-local and ephemeral. Every mutation rewrites it, and restoreAuthorizedKeys()
// re-derives it at boot, so sshd's view and this store never drift.
interface SyncEnrollment {
    // The authorized_keys line, the machine's identity (dedup key for re-enroll).
    readonly key: string;
    // sha256 of the machine's sync token (the raw token never touches disk).
    readonly tokenDigest: string;
    readonly mode: SyncMode;
    // The key line's comment field, the machine label for the UI.
    readonly machine: string;
    readonly enrolledAt: number;
    // When this machine last USED its enrollment (see verifySyncToken). Absent until the first poll, an
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
// machines. An empty store writes an empty file rather than removing it, "nobody is enrolled" must be a state
// sshd can read, not an absence that a leftover file could contradict.
const writeAuthorizedKeys = async (enrollments: readonly SyncEnrollment[]): Promise<void> => {
    await mkdir(dirname(authorizedKeysPath()), { recursive: true, mode: 0o700 });
    await writeFile(authorizedKeysPath(), enrollments.map((entry) => entry.key).join("\n") + (enrollments.length > 0 ? "\n" : ""), { mode: 0o600 });
};

/* Persist the store AND rewrite authorized_keys from it, the two always move together.
 *
 * And say so, because every way this set changes passes through here: a machine redeeming a pairing token, one
 * self-revoking on uninstall, the owner's kill switch. THE REDEMPTION IS THE ONE THAT MATTERED, it lands while
 * the person is looking at the sync card having just pasted a one-liner into their laptop, and it is the moment
 * the card's whole claim changes. The store is on /history rather than in the watched tree, so no
 * `workspaceChanged` batch could ever mention it and this is the only feed that can carry it. */
const persist = async (historyRoot: string, enrollments: SyncEnrollment[]): Promise<void> => {
    await mkdir(historyRoot, { recursive: true });
    await writeFile(enrollmentsPath(historyRoot), JSON.stringify(enrollments), { mode: 0o600 });
    await writeAuthorizedKeys(enrollments);
    publishRuntimeChange("hosts");
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
 * seconds per machine, forever, to answer a question ("is that machine still syncing?") whose useful resolution
 * is minutes. Throttled, a live holder's seenAt is never more than this far behind. */
const SEEN_THROTTLE_MS = 60_000;

/* Whether a presented sync token matches ANY enrollment, the /ports read credential + the self-revoke identity.
 *
 * AND the heartbeat. The agent's ports poll is the one thing a live desktop sync does on its own, every few
 * seconds, so verification is where "this machine is still there" is knowable; nothing else on either end ever
 * asked. Without it an enrollment reads as active from the moment it is made until someone revokes it, so the
 * Desktop-sync card kept claiming "Syncing from <machine>" long after that machine had stopped, which is what a
 * folder silently losing its pairing looks like from the sandbox side, and why it took days to notice.
 *
 * The write goes through persist(), which also rewrites authorized_keys: the key set is unchanged by construction
 * here, and keeping the two coupled is worth more than skipping one small write a minute. A concurrent poll from
 * another machine can lose this stamp to a read-modify-write race; the next poll re-stamps it seconds later. */
const matchEnrollment = (enrollments: readonly SyncEnrollment[], presented: string): SyncEnrollment | undefined => {
    const digest = Buffer.from(digestOf(presented));
    return enrollments.find((entry) => {
        const stored = Buffer.from(entry.tokenDigest);
        return stored.length === digest.length && timingSafeEqual(stored, digest);
    });
};

/* `checkedIn` is what separates the agent DOING ITS JOB from its bytes merely flowing, and the card's whole
 * meaning rests on it. Every route the sync token opens used to stamp seenAt, including the SSH transport, a
 * stream Mutagen's daemon opens and reopens on its own, entirely independently of the watcher that is supposed to
 * be polling. So a watcher whose loop had died left the pill green and the card reading "Syncing from <machine>,
 * just now" while port mirroring, the git bridge and every not-yet-created file sync were stopped: the heartbeat
 * was being taken from a machine that was no longer doing the work.
 *
 * Only the watcher's OWN periodic calls (the ports poll and the machine report) mean "still on the job", so only
 * those stamp. The transport still authorizes exactly as before, it just no longer speaks for the agent. */
export const verifySyncToken = async (historyRoot: string, presented: string, checkedIn: boolean): Promise<boolean> => {
    const enrollments = await readEnrollments(historyRoot);
    const matched = matchEnrollment(enrollments, presented);
    if (matched === undefined) {
        return false;
    }
    const now = Date.now();
    if (checkedIn && (matched.seenAt === undefined || now - matched.seenAt >= SEEN_THROTTLE_MS)) {
        await persist(
            historyRoot,
            // oxlint-disable-next-line oxc/no-map-spread -- an enrollment is readonly; a fresh record for the one machine that polled is the point
            enrollments.map((entry) => (entry === matched ? { ...entry, seenAt: now } : entry)),
        );
    }
    return true;
};

// Whether ANY machine is enrolled, the UI's "desktop sync/mirror active" signal.
export const isKeyEnrolled = async (historyRoot: string): Promise<boolean> => (await readEnrollments(historyRoot)).length > 0;

// The machine holding file sync, as the card needs it: its label plus when it was last heard from. A projection
// rather than the enrollment itself, the record next to these two fields is a key and a token digest, which have
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

// The machines currently mirroring ports (any number), for the UI to show who has live previews.
export const mirrorMachines = async (historyRoot: string): Promise<string[]> =>
    (await readEnrollments(historyRoot)).filter((entry) => entry.mode === "mirror").map((entry) => entry.machine);

// Every enrolled machine's label, whichever mode it holds. A machine belongs on the Computers view's row list
// because it is ENROLLED, not because it has managed to report: one that never posts is exactly the case worth
// showing (an agent too old to report, or a setup that never finished).
const labelsOf = (enrollments: readonly SyncEnrollment[]): string[] => enrollments.map((entry) => entry.machine);

/* WHAT THE MACHINE SAYS ABOUT ITSELF. Everything above is what the SANDBOX knows about an enrollment, that it
 * exists, and roughly when it was last used. None of it can answer the questions the Desktop sync card was
 * actually asked: which folder is this syncing into, which ports did it get onto localhost, is the watcher behind
 * it even alive. Those are facts only the machine holds (SYNC_DIR never reaches the daemon), so the machine
 * volunteers them, on the ports poll it was already making.
 *
 * IN MEMORY, deliberately, unlike the enrollments beside it. A report is a snapshot of a computer that may since
 * have closed its lid, and a daemon restart re-learns it within one poll of every machine still there. Persisting
 * it would mean serving a laptop's folder list back for as long as the record survived, the exact "green over a
 * machine that stopped hours ago" lie the seenAt heartbeat exists to prevent. */
const reports = new Map<string, { readonly report: MachineReport; readonly receivedAt: number }>();

/* Record a machine's report, authorized by the same sync token its ports poll uses. The token decides WHICH
 * machine this is: a report is filed under the enrollment that presented it, never under the hostname it claims,
 * so no machine can post a report in another's name. An unknown token stores nothing and says so. */
export const recordMachineReport = async (historyRoot: string, presented: string, report: MachineReport): Promise<boolean> => {
    const matched = matchEnrollment(await readEnrollments(historyRoot), presented);
    if (matched === undefined) {
        return false;
    }
    reports.set(matched.machine, { report, receivedAt: Date.now() });
    return true;
};

/* The reports of the machines still enrolled, newest first, each beside the enrollment LABEL it was filed under.
 * The label travels with it because it is the only name the sandbox has ever known this machine by (the ssh key's
 * comment, what "Syncing from X" says), while the report carries the machine's own hostname; reconciling a
 * sync-enrolled machine with the same box reached through a host capability needs both.
 *
 * Filtered against the live enrollments rather than returned wholesale: revoking a machine's access has to stop
 * the sandbox showing its folders too, and the in-memory map has no revocation hook of its own. */
const reportsFor = (enrollments: readonly SyncEnrollment[]): { machine: string; report: MachineReport }[] => {
    const enrolled = new Set(labelsOf(enrollments));
    return [...reports.entries()]
        .filter(([machine]) => enrolled.has(machine))
        .toSorted(([, a], [, b]) => b.receivedAt - a.receivedAt)
        .map(([machine, entry]) => ({ machine, report: entry.report }));
};

export const machineReports = async (historyRoot: string): Promise<{ machine: string; report: MachineReport }[]> =>
    reportsFor(await readEnrollments(historyRoot));

/* BOTH ENROLLMENT LISTS OFF ONE READ OF THE FILE, for the Computers view, which needs the labels and the reports
 * together and used to ask for them separately, reading and parsing sync-enrollments.json twice per request.
 * Trivial next to a round trip to a laptop, and free to stop doing now that the round trip is off that path. */
export const enrolledFleet = async (historyRoot: string): Promise<{ machines: string[]; reports: { machine: string; report: MachineReport }[] }> => {
    const enrollments = await readEnrollments(historyRoot);
    return { machines: labelsOf(enrollments), reports: reportsFor(enrollments) };
};

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

// Owner "Disable desktop sync": drop EVERY enrollment (all keys + tokens), the admin kill switch.
export const clearAllEnrollments = async (historyRoot: string): Promise<void> => {
    await persist(historyRoot, []);
};

/* THE SSH HOSTNAME THAT USED TO LIVE HERE is gone, and the reason is worth keeping.
 *
 * Mutagen reached this container by resolving `ssh-<id>.<zone>` and dialling it through the reachability
 * fabric, because a Cloudflare tunnel routes arbitrary TCP. When the fabric moved to a hub that shares HTTP and
 * nothing else, that name became a hostname pointing at nothing, so this derivation started answering
 * `undefined`, the enroll route turned that into a 409, and desktop sync was dead on the ONE path the setup
 * wizard offers by default. It was offered anyway, on by default, failing every time.
 *
 * A second kind of route through the fabric would have fixed the symptom and left the shape: a transport that
 * works or not depending on how a given sandbox happens to be reachable, with a matrix to keep straight. The
 * transport is now this daemon's own HTTPS surface instead (platform/sync-ssh.ts), the one way in that every
 * sandbox has by definition, since it is how the workspace itself is served. Nothing to derive, nothing to
 * provision, and no sandbox that can answer this request but cannot carry sync. */
