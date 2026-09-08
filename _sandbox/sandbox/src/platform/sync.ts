import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DeviceReport } from "@intentic/sandbox-contract";
import { z } from "zod";
import { type JsonFile, jsonFile } from "../store/json-file.js";
import { publishRuntimeChange } from "../system/runtime-watch.js";

// Desktop enrollment for Mutagen: an ed25519 key lands here via a pairing token, then rides SSH for file sync of /work
// and port mirroring of dev servers.
// - sync: file sync + mirroring, single-holder; a second enroll needs an explicit takeover
// - mirror: port mirroring only, unlimited; forwards are read-only and per-machine
// Owner may enroll either mode; a member can only ever get mirror.

export type SyncMode = "sync" | "mirror";

// Pairing carries the mode, trusted over anything the agent claims, since mint is the only point the requester's role
// is known. The setup-time token is armed (not minted) and replayable, which is why this door keeps a burn file.
export const syncPairBurnPath = (historyRoot: string): string => join(historyRoot, "sync-pair-consumed.json");

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
});
type SyncEnrollment = z.infer<typeof SyncEnrollmentSchema>;

const enrollmentsPath = (historyRoot: string): string => join(historyRoot, "sync-enrollments.json");
const authorizedKeysPath = (): string => join(homedir(), ".ssh", "authorized_keys");
const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const machineOf = (key: string): string => key.trim().split(" ")[2] ?? "unknown";

// Backed by store/json-file.ts: atomic writes and a per-file update queue, so a redeem racing a heartbeat stamp can't
// lose an update. One instance per path, since the queue lives on the object; 0o600, since the file holds token
// digests.
const files = new Map<string, JsonFile<SyncEnrollment[]>>();
const enrollmentsFile = (historyRoot: string): JsonFile<SyncEnrollment[]> => {
    const path = enrollmentsPath(historyRoot);
    let file = files.get(path);
    if (file === undefined) {
        file = jsonFile<SyncEnrollment[]>(path, {
            parse: (raw) => z.array(SyncEnrollmentSchema).safeParse(raw).data,
            fallback: () => [],
            mode: 0o600,
        });
        files.set(path, file);
    }
    return file;
};

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
        kept.push({ key, tokenDigest: digestOf(token), mode: args.mode, machine: machineOf(key), enrolledAt: Date.now() });
        outcome = { syncToken: token };
        return kept;
    });
    return outcome;
};

// Max staleness of seenAt before a poll refreshes it; only minute-resolution matters here.
const SEEN_THROTTLE_MS = 60_000;

// Matches a presented token against enrollments; used for both the /ports read credential and the self-revoke identity.
const matchEnrollment = (enrollments: readonly SyncEnrollment[], presented: string): SyncEnrollment | undefined => {
    const digest = Buffer.from(digestOf(presented));
    return enrollments.find((entry) => {
        const stored = Buffer.from(entry.tokenDigest);
        return stored.length === digest.length && timingSafeEqual(stored, digest);
    });
};

// The heartbeat: only the watcher's own periodic calls should mean "still on the job", so `checkedIn` gates whether a
// match refreshes seenAt; the transport itself still authorizes but never stamps.
export const verifySyncToken = async (historyRoot: string, presented: string, checkedIn: boolean): Promise<boolean> => {
    const enrollments = await readEnrollments(historyRoot);
    const matched = matchEnrollment(enrollments, presented);
    if (matched === undefined) {
        return false;
    }
    const now = Date.now();
    if (checkedIn && (matched.seenAt === undefined || now - matched.seenAt >= SEEN_THROTTLE_MS)) {
        await persist(historyRoot, (current) =>
            // oxlint-disable-next-line oxc/no-map-spread -- an enrollment is readonly; a fresh record for the one machine that polled is the point
            current.map((entry) => (entry.key === matched.key ? { ...entry, seenAt: now } : entry)),
        );
    }
    return true;
};

// Whether any machine is enrolled; the UI's desktop sync/mirror active signal.
export const isKeyEnrolled = async (historyRoot: string): Promise<boolean> => (await readEnrollments(historyRoot)).length > 0;

// One row per enrolled machine, present whether or not it has ever reported (a never-polled machine is a real case to
// show). Excludes the key and token digest; those have no business reaching a browser.
export type SyncEnrollmentRow = Pick<SyncEnrollment, "machine" | "mode"> & { readonly seenAt?: number };

const rowsOf = (enrollments: readonly SyncEnrollment[]): SyncEnrollmentRow[] =>
    enrollments.map((entry) => ({ machine: entry.machine, mode: entry.mode, ...(entry.seenAt === undefined ? {} : { seenAt: entry.seenAt }) }));

// Machine names only, for a filter that only needs to check "is this still enrolled".
const labelsOf = (enrollments: readonly SyncEnrollment[]): string[] => enrollments.map((entry) => entry.machine);

// In memory only: a stale report would serve a laptop's old folder list long after it's gone.
const reports = new Map<string, { readonly report: DeviceReport; readonly receivedAt: number }>();

// Files a report under the enrollment the token matched, never the hostname it claims, so a machine can't post under
// another's name.
export const recordDeviceReport = async (historyRoot: string, presented: string, report: DeviceReport): Promise<boolean> => {
    const matched = matchEnrollment(await readEnrollments(historyRoot), presented);
    if (matched === undefined) {
        return false;
    }
    reports.set(matched.machine, { report, receivedAt: Date.now() });
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

// Both enrollment lists off one read of the file, for a view that needs labels and reports together.
export const enrolledFleet = async (
    historyRoot: string,
): Promise<{ machines: SyncEnrollmentRow[]; reports: { machine: string; report: DeviceReport }[] }> => {
    const enrollments = await readEnrollments(historyRoot);
    return { machines: rowsOf(enrollments), reports: reportsFor(enrollments) };
};

// Self-revoke: drops the enrollment owning this token, returns false if none matched. Rewrites authorized_keys, so SSH
// access dies with it.
export const revokeEnrollmentByToken = async (historyRoot: string, token: string): Promise<boolean> => {
    const digest = digestOf(token);
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
