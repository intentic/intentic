import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { queueOnFile, writeFileAtomic } from "@intentic/base/fs";
import { type DeviceReport, environmentOf } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { tokenEquals } from "../auth/auth.js";
import { type Burns, burnsAt, type Presented, syncPairConsumedDocument } from "./enrollment.js";
import { defineDocument } from "../store/evolution/documents.js";
import { type JsonFile, ManifestUnreadableError } from "../store/json-file.js";
import { openEntries } from "../store/open-document.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";

// Desktop enrollment for Mutagen: an ed25519 key lands here via a pairing token, then rides SSH for file sync of /work
// and port mirroring of dev servers.
// - sync: file sync + mirroring, single-holder; a second enroll needs an explicit takeover
// - mirror: port mirroring only, unlimited; forwards are read-only and per-machine
// Owner may enroll either mode; a member can only ever get mirror.

export type SyncMode = "sync" | "mirror";

// Pairing carries the mode, trusted over anything the agent claims, since mint is the only point the requester's role
// is known. The setup-time token is armed (not minted) and replayable, which is why this door keeps a burn file.
export const syncPairBurns = (historyRoot: string): Burns => burnsAt(syncPairConsumedDocument, historyRoot);

// Store of every machine's key/token/mode, on /history: outside /work (agent can't read it) and outside the container
// fs (survives a rebuild). authorized_keys is derived from it and re-derived at boot, never stored alongside it.
const SyncEnrollmentSchema = z.object({
    // The authorized_keys line; also the dedup key for re-enroll.
    key: z.string(),
    // sha256 of the sync token; the raw token never touches disk.
    tokenDigest: z.string(),
    mode: z.enum(["sync", "mirror"]),
    // Machine label for the UI, taken from the key line's comment field.
    machine: z.string(),
    enrolledAt: z.number(),
    // When this machine last used its enrollment (see verifySyncToken); absent until the first poll.
    seenAt: z.number().optional(),
    // Which computer, and which OS install on it, holds this enrollment: what joins it to the same machine's card.
    // Said by the agent when it enrolls, or stamped from the first report it posts; absent from an agent too old to say.
    machineId: z.string().optional(),
    environment: z.string().optional(),
});
type SyncEnrollment = z.infer<typeof SyncEnrollmentSchema>;

const enrollmentsPath = (historyRoot: string): string => join(historyRoot, syncEnrollmentsDocument.path);

export const syncEnrollmentsDocument = defineDocument({
    root: "history",
    path: "sync-enrollments.json",
    schema: SyncEnrollmentSchema,
    granularity: "entries",
});
// HOME is the home directory of record, read per call so a test can point it at a temp dir.
const authorizedKeysPath = (): string => join(process.env["HOME"] ?? homedir(), ".ssh", "authorized_keys");
const machineOf = (key: string): string => key.trim().split(" ")[2] ?? "unknown";

// WHICH ENROLLMENT IS WHICH (2026-10-05). An enrollment was keyed by its whole key line and named by the line's comment,
// which every machine agent spelled as the bare hostname. A Windows PC runs an agent on its Windows side and one in each
// WSL distro, each with a key of its own, and WSL hands every distro the PC's hostname: so both sides enrolled under one
// name, their reports overwrote each other in the one slot a name had, and revoking one by name revoked both. Now:
// - the same enrollment is the same KEY (its type and body, whatever its comment), or the same computer and environment
//   on it when both records say so (`sameEnrollment`), so a side that made itself a new key replaces its own record;
// - a report is filed under the enrollment's key, not its name (`reports`);
// - two enrollments that share a name but are different environments of one PC are told apart by name too: the one
//   that is not the native environment takes its distro's name after its own (`distinctLabels`). The native one keeps
//   the hostname, which is what setup's own card is placed by (device-reports.ts).
// A new agent also names its key `<hostname>-<environment>` (the machine's sync/environment.ts), so a new enrollment
// arrives distinct; the rule above is what sorts out every enrollment made before that.

// A key line's type and body, its comment dropped: the part sshd authenticates, and so the part that says which key.
export const keyMaterialOf = (key: string): string => key.trim().split(/\s+/).slice(0, 2).join(" ");

// The computer and environment an enrollment says it is, when it says both.
const identityOf = (entry: Pick<SyncEnrollment, "machineId" | "environment">): string | undefined =>
    entry.machineId === undefined || entry.environment === undefined ? undefined : `${entry.machineId}\n${entry.environment}`;

export const sameEnrollment = (
    left: Pick<SyncEnrollment, "key" | "machineId" | "environment">,
    right: Pick<SyncEnrollment, "key" | "machineId" | "environment">,
): boolean => keyMaterialOf(left.key) === keyMaterialOf(right.key) || (identityOf(left) !== undefined && identityOf(left) === identityOf(right));

// A distro's name as a label's tail: what follows `wsl:`, in characters an authorized_keys comment and a URL both keep.
const environmentTail = (environment: string): string => environment.replace(/^wsl:/, "").replaceAll(/[^A-Za-z0-9._-]+/g, "-");

// Enrollments that share a name, told apart: each one that is not the native environment and says which environment it
// is takes `<name>-<distro>`, made unique against every other name held. Idempotent: a renamed one no longer shares its
// name, and one whose environment is unknown, or native, keeps its name.
export const distinctLabels = (enrollments: readonly SyncEnrollment[]): SyncEnrollment[] => {
    const taken = new Set(enrollments.map((entry) => entry.machine));
    return enrollments.map((entry) => {
        const sharing = enrollments.filter((other) => other.machine === entry.machine);
        if (sharing.length < 2 || entry.environment === undefined || entry.environment === "native" || !entry.environment.startsWith("wsl:")) {
            return entry;
        }
        const base = `${entry.machine}-${environmentTail(entry.environment)}`;
        const machine =
            [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((count) => `${base}-${count}`)].find((candidate) => !taken.has(candidate)) ??
            `${base}-${Date.now()}`;
        taken.add(machine);
        // oxlint-disable-next-line oxc/no-map-spread -- Each enrollment update creates a fresh record.
        return { ...entry, machine };
    });
};

// HOW LONG AN ENROLLMENT NOBODY USES IS KEPT (2026-10-05): ninety days since it was last seen (its agent's own polls
// stamp `seenAt`, at most once a minute), or since it was made when it never was. `seenAt` was written and never read,
// so every key a machine ever enrolled stayed in authorized_keys for good, a laptop given away included. Applied on
// every write of the store and at boot, which rebuilds authorized_keys from what is kept (`restoreAuthorizedKeys`).
export const ENROLLMENT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export const withoutStale = (enrollments: readonly SyncEnrollment[], now: number): SyncEnrollment[] =>
    enrollments.filter((entry) => now - (entry.seenAt ?? entry.enrolledAt) < ENROLLMENT_RETENTION_MS);

// Atomic writes and a per-path update queue (store/json-file.ts), so a redeem racing a heartbeat stamp can't lose an
// update; 0o600, since the file holds token digests. Refused rather than set aside when this build cannot read it:
// setting it aside would drop every machine's digest, so one new enrollment would read every other machine as revoked
// instead of unavailable. A write over it throws ManifestUnreadableError.
const enrollmentsFile = (historyRoot: string): JsonFile<SyncEnrollment[]> =>
    openEntries(syncEnrollmentsDocument, enrollmentsPath(historyRoot), { mode: 0o600, idKeys: ["key"], onUnreadable: "refuse" });

const readEnrollments = (historyRoot: string): Promise<SyncEnrollment[]> => enrollmentsFile(historyRoot).read();

// Re-derives authorized_keys from the store as it stands now: one key line per enrollment, and an empty file for an
// empty store, so sshd can read "nobody enrolled" rather than find nothing. A store this build cannot read reads as
// empty here, so sshd admits nobody until it is fixed.
// Queued on authorized_keys and reading the store inside the queue, never handed a snapshot: two writes that each carried
// their own copy could land the older one last, and a key revoked in between would come back. Each derivation starts
// after the store write that asked for it, so the last one to land reads at least the newest store. Written atomically,
// so sshd never reads a truncated file.
const syncAuthorizedKeys = (historyRoot: string): Promise<void> =>
    queueOnFile(authorizedKeysPath(), async () => {
        const enrollments = await readEnrollments(historyRoot);
        await mkdir(dirname(authorizedKeysPath()), { recursive: true, mode: 0o700 });
        await writeFileAtomic(authorizedKeysPath(), enrollments.map((entry) => entry.key).join("\n") + (enrollments.length > 0 ? "\n" : ""), 0o600);
    });

// Every store write re-derives authorized_keys once it lands (`syncAuthorizedKeys`); returning the same array means
// no-op. Publishes its own change, since /history is outside the watched tree.
// Every write also drops what is past retention (`withoutStale`), and the reports of what it dropped go with them.
const persist = async (historyRoot: string, change: (current: SyncEnrollment[]) => SyncEnrollment[], now: number = Date.now()): Promise<boolean> => {
    let changed = false;
    let dropped: readonly SyncEnrollment[] = [];
    await enrollmentsFile(historyRoot).update((current) => {
        const next = change(current);
        const kept = withoutStale(next, now);
        dropped = next.filter((entry) => !kept.includes(entry));
        changed = next !== current || dropped.length > 0;
        return changed ? kept : current;
    });
    for (const entry of dropped) {
        reports.delete(keyMaterialOf(entry.key));
    }
    if (changed) {
        await syncAuthorizedKeys(historyRoot);
        publishRuntimeChange("hosts");
    }
    return changed;
};

// Re-derives authorized_keys from the store at boot, since a recreate leaves enrollments intact but the file gone, and
// drops what is past retention first, so a key nobody has used in ninety days does not come back with the container.
export const restoreAuthorizedKeys = async (historyRoot: string, now: number = Date.now()): Promise<void> => {
    if (!(await persist(historyRoot, (current) => current, now))) {
        await syncAuthorizedKeys(historyRoot);
    }
};

// One key line: known type, base64 blob, optional comment, no embedded newline (blocks smuggled entries).
const KEY_LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( \S+)?$/;

export const isValidAuthorizedKey = (key: string): boolean => !key.includes("\n") && KEY_LINE.test(key.trim());

// Enrolls a key under `mode`; a conflicting sync holder returns `{ locked }` unless `takeover`, which replaces it and
// drops its key/token. Mirror is always accepted; re-enrolling the same machine rotates its token.
export const enrollSyncKey = async (args: {
    historyRoot: string;
    key: string;
    mode: SyncMode;
    takeover: boolean;
    // What the agent said it is; absent from an agent too old to say, when the first report it posts stamps it instead.
    machineId?: string | undefined;
    environment?: string | undefined;
}): Promise<{ syncToken: string } | { locked: string }> => {
    const key = args.key.trim();
    const incoming = {
        key,
        ...(args.machineId === undefined ? {} : { machineId: args.machineId }),
        ...(args.environment === undefined ? {} : { environment: args.environment }),
    };
    let outcome: { syncToken: string } | { locked: string } = { locked: "" };
    await persist(args.historyRoot, (enrollments) => {
        if (args.mode === "sync") {
            const holder = enrollments.find((entry) => entry.mode === "sync" && !sameEnrollment(entry, incoming));
            if (holder !== undefined && !args.takeover) {
                outcome = { locked: holder.machine };
                return enrollments;
            }
        }
        // Drops this machine's prior record (the same key, or the same computer and environment under a new key), and on
        // takeover the existing sync holder; mirror always survives.
        const kept = enrollments.filter((entry) => !sameEnrollment(entry, incoming) && !(args.mode === "sync" && entry.mode === "sync"));
        const token = `ist_${randomBytes(32).toString("base64url")}`;
        kept.push({ ...incoming, tokenDigest: sha256Hex(token), mode: args.mode, machine: machineOf(key), enrolledAt: Date.now() });
        outcome = { syncToken: token };
        return distinctLabels(kept);
    });
    return outcome;
};

// Max staleness of seenAt before a poll refreshes it; only minute-resolution matters here.
const SEEN_THROTTLE_MS = 60_000;

// Matches a presented token against enrollments; used for both the /ports read credential and the self-revoke identity.
// Fixed-length hex digests, so the comparison is timing-safe whatever the presented token's length.
const matchEnrollment = (enrollments: readonly SyncEnrollment[], presented: string): SyncEnrollment | undefined => {
    const digest = sha256Hex(presented);
    return enrollments.find((entry) => tokenEquals(entry.tokenDigest, digest));
};

// The heartbeat: only the watcher's own periodic calls should mean "still on the job", so `checkedIn` gates whether a
// match refreshes seenAt; the transport itself still authorizes but never stamps.
export const verifySyncToken = async (historyRoot: string, presented: string, checkedIn: boolean): Promise<Presented> => {
    // `state`, not `read`: an unreadable store's empty fallback would read as a revocation and drop a live pairing.
    const stored = await enrollmentsFile(historyRoot).state();
    if (stored.unreadable) {
        return { kind: "unreadable", detail: stored.detail };
    }
    const matched = matchEnrollment(stored.value, presented);
    if (matched === undefined) {
        return { kind: "unknown" };
    }
    const now = Date.now();
    if (checkedIn && (matched.seenAt === undefined || now - matched.seenAt >= SEEN_THROTTLE_MS)) {
        await persist(historyRoot, (current) =>
            // oxlint-disable-next-line oxc/no-map-spread -- Each enrollment update creates a fresh record.
            current.map((entry) => (entry.key === matched.key ? { ...entry, seenAt: now } : entry)),
        );
    }
    return { kind: "enrolled", id: matched.machine, card: matched.machine };
};

// Whether any machine is enrolled; the UI's desktop sync/mirror active signal.
export const isKeyEnrolled = async (historyRoot: string): Promise<boolean> => (await readEnrollments(historyRoot)).length > 0;

// Whether any machine carries this sandbox's FILES, as opposed to only mirroring its ports. The difference is the
// whole of "is there a copy of this work anywhere else", which a plain enrollment count cannot answer.
export const isFileSyncEnrolled = async (historyRoot: string): Promise<boolean> =>
    (await readEnrollments(historyRoot)).some((enrollment) => enrollment.mode === "sync");

// One row per enrolled machine, present whether or not it has ever reported (a never-polled machine is a real case to
// show). Excludes the key and token digest; those have no business reaching a browser.
export type SyncEnrollmentRow = Pick<SyncEnrollment, "machine" | "mode"> & {
    readonly seenAt?: number;
    readonly machineId?: string;
    readonly environment?: string;
};

const rowsOf = (enrollments: readonly SyncEnrollment[]): SyncEnrollmentRow[] =>
    enrollments.map((entry) => ({
        machine: entry.machine,
        mode: entry.mode,
        ...(entry.seenAt === undefined ? {} : { seenAt: entry.seenAt }),
        ...(entry.machineId === undefined ? {} : { machineId: entry.machineId }),
        ...(entry.environment === undefined ? {} : { environment: entry.environment }),
    }));

// In memory only: a stale report would serve a laptop's old folder list long after it's gone. Keyed by the enrollment's
// key (`keyMaterialOf`), never its name: two environments of one PC that share a name each keep their own.
const reports = new Map<string, { readonly report: DeviceReport; readonly receivedAt: number }>();

// Who is told of each report taken in, so this store never imports what one sets in motion: on a projects host, the
// folders it names are attached (bootstrap/projects-host.ts). The report is answered only once every listener settled,
// or REPORT_LISTENER_WAIT_MS passed: the machine agent starts copying a newly attached folder only after the sandbox
// answered a report naming it, so a folder's repo stands before its first file arrives and the root repo never reads
// those files as its own. A listener past the wait goes on; the machine reads the slow answer as a failed post and
// reports again on its next pass.
type ReportListener = (report: DeviceReport) => void | Promise<void>;
const reportListeners = new Set<ReportListener>();
export const REPORT_LISTENER_WAIT_MS = 30_000;
export const subscribeDeviceReports = (listener: ReportListener): (() => void) => {
    reportListeners.add(listener);
    return () => reportListeners.delete(listener);
};

const heardBy = async (report: DeviceReport): Promise<void> => {
    if (reportListeners.size === 0) {
        return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REPORT_LISTENER_WAIT_MS);
        timer.unref?.();
    });
    const settled = Promise.allSettled([...reportListeners].map(async (listener) => listener(report)));
    await Promise.race([settled, waited]);
    clearTimeout(timer);
};

// Files a report under the enrollment the token matched, never the hostname it claims, so a machine can't post under
// another's name. The first report that says which computer and install it is from stamps the enrollment with both:
// how an enrollment made by an agent too old to say learns it, once, without re-pairing. Only the matched record moves.
export const recordDeviceReport = async (historyRoot: string, presented: string, report: DeviceReport): Promise<boolean> => {
    const matched = matchEnrollment(await readEnrollments(historyRoot), presented);
    if (matched === undefined) {
        return false;
    }
    reports.set(keyMaterialOf(matched.key), { report, receivedAt: Date.now() });
    // Only a report its own enrollment's token vouched for reaches a listener.
    await heardBy(report);
    const environment = environmentOf(undefined, report);
    if (report.machineId !== undefined && (matched.machineId !== report.machineId || matched.environment !== environment)) {
        // Once both sides of a PC have said which they are, two that shared a name stop sharing it (`distinctLabels`).
        await persist(historyRoot, (current) =>
            distinctLabels(
                current.map((entry) =>
                    // oxlint-disable-next-line oxc/no-map-spread -- Each enrollment update creates a fresh record.
                    entry.key === matched.key
                        ? { ...entry, machineId: report.machineId, ...(environment === undefined ? {} : { environment }) }
                        : entry,
                ),
            ),
        );
    }
    return true;
};

// Pairs each report with the enrollment label it was filed under (the sandbox's only name for the machine, not its own
// hostname). Filtered against live enrollments, so revoking access also stops its reports being shown.
const reportsFor = (enrollments: readonly SyncEnrollment[]): { machine: string; report: DeviceReport }[] =>
    enrollments
        .flatMap((enrollment) => {
            const held = reports.get(keyMaterialOf(enrollment.key));
            return held === undefined ? [] : [{ machine: enrollment.machine, ...held }];
        })
        .toSorted((a, b) => b.receivedAt - a.receivedAt)
        .map(({ machine, report }) => ({ machine, report }));

export const deviceReports = async (historyRoot: string): Promise<{ machine: string; report: DeviceReport }[]> =>
    reportsFor(await readEnrollments(historyRoot));

// Named because it crosses a subsystem line: composition.ts exposes this read as `services.syncFleet` so the devices
// view can merge enrollments without importing this module's code.
export interface SyncFleet {
    readonly machines: readonly SyncEnrollmentRow[];
    readonly reports: readonly { machine: string; report: DeviceReport }[];
}

// Both enrollment lists off one read of the file, for a view that needs labels and reports together.
export const enrolledFleet = async (historyRoot: string): Promise<SyncFleet> => {
    const enrollments = await readEnrollments(historyRoot);
    return { machines: rowsOf(enrollments), reports: reportsFor(enrollments) };
};

// Self-revoke: drops the enrollment owning this token, returns false if none matched. Rewrites authorized_keys, so SSH
// access dies with it.
export const revokeEnrollmentByToken = async (historyRoot: string, token: string): Promise<boolean> => {
    const digest = sha256Hex(token);
    return (await revokeWhere(historyRoot, (entry) => tokenEquals(entry.tokenDigest, digest))) > 0;
};

// Drops every enrollment `revoked` picks in one write, and their in-memory reports with them, or a report would outlive
// its enrollment until the process restarts. Answers how many went.
// Over a store this build cannot read, nothing matches and nothing is written, so the revoke would answer "not enrolled"
// while the key stays in authorized_keys: refused instead, and authorized_keys re-derived from what can be read, which is
// nobody, so sshd admits no one until the store is fixed.
const revokeWhere = async (historyRoot: string, revoked: (entry: SyncEnrollment) => boolean): Promise<number> => {
    const stored = await enrollmentsFile(historyRoot).state();
    if (stored.unreadable) {
        await syncAuthorizedKeys(historyRoot);
        throw new ManifestUnreadableError(enrollmentsPath(historyRoot), stored.detail);
    }
    let gone: SyncEnrollment[] = [];
    await persist(historyRoot, (enrollments) => {
        gone = enrollments.filter(revoked);
        return gone.length > 0 ? enrollments.filter((entry) => !revoked(entry)) : enrollments;
    });
    for (const entry of gone) {
        reports.delete(keyMaterialOf(entry.key));
    }
    return gone.length;
};

// Revokes one machine by name, the identity the row shows. Nothing happens on that machine directly; its agent notices
// within a poll and stops on its own.
export const revokeEnrollmentByMachine = async (historyRoot: string, machine: string): Promise<boolean> =>
    (await revokeWhere(historyRoot, (entry) => entry.machine === machine)) > 0;

// REMOVING A DEVICE'S CARD TAKES ITS SYNC ENROLLMENTS TOO (2026-10-05). The card's own enrollments (the device door) were
// revoked, and the ssh key the same computer syncs with stayed in authorized_keys under no card at all, which no screen
// listed. Each OS install the card held is named by its computer and environment, and every sync enrollment that says it
// is one of those goes. One that never said which it is (an agent too old to) is left: it is named by a hostname, which
// is no proof it is that computer. Answers how many went.
export const revokeSyncEnrollmentsOf = async (
    historyRoot: string,
    installs: readonly { readonly machineId: string; readonly environment: string }[],
): Promise<number> => {
    const wanted = new Set(installs.map((install) => identityOf(install)));
    return installs.length === 0 ? 0 : await revokeWhere(historyRoot, (entry) => wanted.has(identityOf(entry)));
};
