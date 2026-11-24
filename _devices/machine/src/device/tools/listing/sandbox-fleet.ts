import { execBounded } from "@intentic/base/process";
import { homeDir } from "@intentic/local-agent";
import { type DeviceSandbox, DeviceSandboxSchema } from "@intentic/sandbox-contract/schemas/devices";
import { z } from "zod";
import { ensureCurrentIc, icCandidates, icOutOfDate } from "../ic-binary.js";
import { askIcServe } from "../ic-serve/ic-serve.js";
import { sharedReading } from "./ic-readings.js";
import { withName } from "./listed-name.js";

// WHAT RUNS ON THIS MACHINE, as `ic sandbox list --json` answers it: one producer of "what runs on me", whoever is asking
// (the keeper, the rounds, the resident check, the egress and move flows, every linked sandbox's Devices pull), and one
// listing shared by all of them (ic-readings.ts).
// Long enough for a listing on a busy machine (ic bounds each docker read inside it at 20s); longer is a machine in
// trouble, and every caller is a screen or a model waiting to draw.
const LIST_TIMEOUT_MS = 60_000;

// Room for every container's share, well past exec's 1 MB default.
const MAX_BUFFER = 8 * 1024 * 1024;

// One row of the listing as it arrived, before it is read as the contract's.
const ListedRowSchema = z.record(z.string(), z.json());
type ListedRow = z.infer<typeof ListedRowSchema>;

// What a row is (which sandbox, its container, whether it runs, on what image) against what an ic newer than this agent
// may say about it in a way this agent cannot read yet: a new outcome word, a new kind of rollback target.
const REQUIRED_FIELDS: ReadonlySet<string> = new Set(["slug", "container", "running", "image"]);

// A row read as the contract's, dropping only the optional fields that do not parse, so a newer ic's answer about one
// of them costs that field rather than the whole listing. A row whose identity does not parse is no row at all.
const rowFrom = (listed: ListedRow): DeviceSandbox | undefined => {
    const row = withName(listed);
    const whole = DeviceSandboxSchema.safeParse(row);
    if (whole.success) {
        return whole.data;
    }
    const failed = new Set(whole.error.issues.map((issue) => String(issue.path[0] ?? "")));
    if ([...failed].some((field) => REQUIRED_FIELDS.has(field) || field === "")) {
        return undefined;
    }
    const kept = DeviceSandboxSchema.safeParse(Object.fromEntries(Object.entries(row).filter(([field]) => !failed.has(field))));
    return kept.success ? kept.data : undefined;
};

// `ic sandbox list --json` prints one line of JSON on stdout (notes, if any, go to stderr), in the contract's own
// shape: running state, the share docker enforces, the shape the container runs with, the shape saved for its next
// restart, the update staged for it, and (from a newer ic) its version, whether it is parked mid-swap, its probation
// and what it can roll back to. Parsed, not trusted: a line that is not a list of rows is ic too old or broken.
export const fleetFrom = (stdout: string): DeviceSandbox[] => {
    const line = stdout
        .split(/\r?\n/)
        .map((text) => text.trim())
        .findLast((text) => text.startsWith("["));
    const parsed = line === undefined ? undefined : z.array(ListedRowSchema).safeParse(JSON.parse(line));
    const rows = parsed?.success === true ? parsed.data.map(rowFrom) : [undefined];
    const read = rows.filter((row) => row !== undefined);
    if (read.length !== rows.length) {
        throw new Error("The `ic` on this device did not answer `ic sandbox list --json`. Re-run the sandbox's install command on it to update ic.");
    }
    return read;
};

const LIST_ARGS = ["sandbox", "list", "--json"] as const;

// A refused listing as a card falling back to a command shows it (Device.sandboxesUnread). An ic this agent failed to
// bring up to date is the likeliest reason, and its note names both versions: first, since the first line is what shows.
const listRefused = (said: string): Error => {
    const stale = icOutOfDate();
    return new Error(`${stale === undefined ? "" : `${stale}\n\n`}ic could not list this device's sandboxes: ${said.trim()}`);
};

// What runs on this machine, as ic answers it, read once for every caller below: the resident ic's answer when there is
// one (ic-serve.ts; a timeout there is a timeout here, as a spawned ic's is), else a spawned ic's.
const readFleet = async (): Promise<DeviceSandbox[]> => {
    const served = await askIcServe(LIST_ARGS, LIST_TIMEOUT_MS);
    if (served !== undefined) {
        if (served === "timeout" || served.code !== 0) {
            throw listRefused(served === "timeout" ? "" : served.stderr);
        }
        return fleetFrom(served.stdout);
    }
    const candidates = icCandidates(process.platform, homeDir());
    for (const [index, binary] of candidates.entries()) {
        // candidates are tried in order; ENOENT means try the next
        const answer = await execBounded(binary, [...LIST_ARGS], { timeoutMs: LIST_TIMEOUT_MS, maxOutput: MAX_BUFFER }).catch(
            (error: NodeJS.ErrnoException & { stderr?: string }) => {
                if (error.code === "ENOENT" && index < candidates.length - 1) {
                    return undefined;
                }
                throw error.code === "ENOENT"
                    ? new Error("This device has no `ic` command, so its sandboxes can't be listed or managed from here. Re-run the sandbox's install command on it to get one.")
                    : listRefused(error.stderr ?? error.message);
            },
        );
        if (answer !== undefined) {
            return fleetFrom(answer.stdout);
        }
    }
    throw new Error("no ic candidate was tried");
};

// (2026-11-24) How long one listing answers every caller (ic-readings.ts says why): the time a linked sandbox holds the
// listing it pulled anyway (the daemon's PULL_TTL_MS), so N sandboxes pulling every 30 s cost two listings a minute, not
// 2N. Every changing `ic` run of this agent drops it, so the hold only bounds how late a change made elsewhere (a
// person's own `ic`, the desktop app) shows.
const FLEET_HELD_MS = 30_000;
const listing = sharedReading(readFleet, { heldMs: FLEET_HELD_MS });

// What runs on this machine, as ic answers it, shared by every caller (FLEET_HELD_MS). `current: false` asks whatever ic
// is installed without first fetching a newer one: what a command deciding whether the agent stays needs (resident.ts),
// where a download would be out of place. `fresh` reads again whatever is held, for a caller that must see the machine
// as it is now.
export const fleet = async ({ current = true, fresh = false }: { readonly current?: boolean; readonly fresh?: boolean } = {}): Promise<DeviceSandbox[]> => {
    if (current) {
        await ensureCurrentIc();
    }
    // A copy: one caller's sort or splice must not reach the next caller's rows.
    return [...(await listing.get({ fresh }))];
};
