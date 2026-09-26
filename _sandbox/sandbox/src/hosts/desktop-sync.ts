import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type DeviceReport, environmentOf } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { tokenEquals } from "../auth/auth.js";
import { type Burns, burnsAt, type Presented, syncPairConsumedDocument } from "../peers/enrollment.js";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
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

export const syncEnrollmentsDocument = defineDocument({ root: "history", path: "sync-enrollments.json", schema: SyncEnrollmentSchema, granularity: "entries" });
// HOME is the home directory of record, read per call so a test can point it at a temp dir.
const authorizedKeysPath = (): string => join(process.env["HOME"] ?? homedir(), ".ssh", "authorized_keys");
const machineOf = (key: string): string => key.trim().split(" ")[2] ?? "unknown";

// Atomic writes and a per-path update queue (store/json-file.ts), so a redeem racing a heartbeat stamp can't lose an
// update; 0o600, since the file holds token digests.
const enrollmentsFile = (historyRoot: string): JsonFile<SyncEnrollment[]> =>
    openEntries(syncEnrollmentsDocument, enrollmentsPath(historyRoot), { mode: 0o600, idKeys: ["key"] });

const readEnrollments = (historyRoot: string): Promise<SyncEnrollment[]> => enrollmentsFile(historyRoot).read();

// One key line per enrollment; an empty store writes an empty file, so sshd can read "nobody enrolled" rather than find
// nothing.
const writeAuthorizedKeys = async (enrollments: readonly SyncEnrollment[]): Promise<void> => {
    await mkdir(dirname(authorizedKeysPath()), { recursive: true, mode: 0o700 });
    await writeFile(authorizedKeysPath(), enrollments.map((entry) => entry.key).join("\n") + (enrollments.length > 0 ? "\n" : ""), { mode: 0o600 });
};

// Store and authorized_keys always move together, inside the file's own update queue; returning the same array means
// no-op. Publishes its own change, since /history is outside the watched tree.
const persist = async (historyRoot: string, change: (current: SyncEnrollment[]) => SyncEnrollment[]): Promise<void> => {
    let changed = false;
    const enrollments = await enrollmentsFile(historyRoot).update((current) => {
        const next = change(current);
        changed = next !== current;
        return next;
    });
    if (changed) {
        await writeAuthorizedKeys(enrollments);
        publishRuntimeChange("hosts");
    }
};

// Re-derives authorized_keys from the store at boot, since a recreate leaves enrollments intact but the file gone.
export const restoreAuthorizedKeys = async (historyRoot: string): Promise<void> => {
    await writeAuthorizedKeys(await readEnrollments(historyRoot));
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
    let outcome: { syncToken: string } | { locked: string } = { locked: "" };
    await persist(args.historyRoot, (enrollments) => {
        if (args.mode === "sync") {
            const holder = enrollments.find((entry) => entry.mode === "sync" && entry.key !== key);
            if (holder !== undefined && !args.takeover) {
                outcome = { locked: holder.machine };
                return enrollments;
            }
        }
        // Drops this machine's prior record, and on takeover the existing sync holder; mirror always survives.
        const kept = enrollments.filter((entry) => entry.key !== key && !(args.mode === "sync" && entry.mode === "sync"));
        const token = `ist_${randomBytes(32).toString("base64url")}`;
        kept.push({
            key,
            tokenDigest: sha256Hex(token),
            mode: args.mode,
            machine: machineOf(key),
            enrolledAt: Date.now(),
            ...(args.machineId === undefined ? {} : { machineId: args.machineId }),
            ...(args.environment === undefined ? {} : { environment: args.environment }),
        });
        outcome = { syncToken: token };
        return kept;
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

// Machine names only, for a filter that only needs to check "is this still enrolled".
const labelsOf = (enrollments: readonly SyncEnrollment[]): string[] => enrollments.map((entry) => entry.machine);

// In memory only: a stale report would serve a laptop's old folder list long after it's gone.
const reports = new Map<string, { readonly report: DeviceReport; readonly receivedAt: number }>();

// Files a report under the enrollment the token matched, never the hostname it claims, so a machine can't post under
// another's name. The first report that says which computer and install it is from stamps the enrollment with both:
// how an enrollment made by an agent too old to say learns it, once, without re-pairing. Only the matched record moves.
export const recordDeviceReport = async (historyRoot: string, presented: string, report: DeviceReport): Promise<boolean> => {
    const matched = matchEnrollment(await readEnrollments(historyRoot), presented);
    if (matched === undefined) {
        return false;
    }
    reports.set(matched.machine, { report, receivedAt: Date.now() });
    const environment = environmentOf(undefined, report);
    if (report.machineId !== undefined && (matched.machineId !== report.machineId || matched.environment !== environment)) {
        await persist(historyRoot, (current) =>
            current.map((entry) =>
                // oxlint-disable-next-line oxc/no-map-spread -- Each enrollment update creates a fresh record.
                entry.key === matched.key ? { ...entry, machineId: report.machineId, ...(environment === undefined ? {} : { environment }) } : entry,
            ),
        );
    }
    return true;
};

// Pairs each report with the enrollment label it was filed under (the sandbox's only name for the machine, not its own
// hostname). Filtered against live enrollments, so revoking access also stops its reports being shown.
const reportsFor = (enrollments: readonly SyncEnrollment[]): { machine: string; report: DeviceReport }[] => {
    const enrolled = new Set(labelsOf(enrollments));
    return [...reports.entries()]
        .filter(([machine]) => enrolled.has(machine))
        .toSorted(([, a], [, b]) => b.receivedAt - a.receivedAt)
        .map(([machine, entry]) => ({ machine, report: entry.report }));
};

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
    let revoked = false;
    await persist(historyRoot, (enrollments) => {
        const kept = enrollments.filter((entry) => entry.tokenDigest !== digest);
        revoked = kept.length !== enrollments.length;
        return revoked ? kept : enrollments;
    });
    return revoked;
};

// Revokes one machine by name, the identity `reports` and the row already use. Nothing happens on that machine
// directly; its agent notices within a poll and stops on its own.
export const revokeEnrollmentByMachine = async (historyRoot: string, machine: string): Promise<boolean> => {
    let revoked = false;
    await persist(historyRoot, (enrollments) => {
        const kept = enrollments.filter((entry) => entry.machine !== machine);
        revoked = kept.length !== enrollments.length;
        return revoked ? kept : enrollments;
    });
    // Drops the machine's in-memory report too, or it would outlive the enrollment until the process restarts.
    if (revoked) {
        reports.delete(machine);
    }
    return revoked;
};
