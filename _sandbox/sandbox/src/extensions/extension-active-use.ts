import type { Capability } from "@intentic/sandbox-contract";
import { z } from "zod";
import { type JsonFile, jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/state-paths.js";

/* WHICH PREMIUM EXTENSIONS WERE ACTUALLY USED, PER UTC DAY (<workspace>/.intentic/extension-active-use.json)
 * — the sandbox's half of the creator pool's ledger.
 *
 * The pool pays a premium extension by RETAINED ACTIVE USE: the unit is "this member's sandbox used this
 * extension on this day", nothing finer. That choice is the privacy design as much as the economics: a day
 * bit per extension id is the least a revenue share can run on, so it is also all that is recorded and all
 * that ever leaves the sandbox (platform/pool-report.ts). No routes, no counts, no content — those stay in
 * extension-usage.ts next door, which never leaves the machine.
 *
 * Marked only for extensions installed with `tier: "premium"` on their capability config: a free extension,
 * a workspace draft or a private internal install reports nothing, so the platform learns nothing about
 * them — not even their names. Self-pruning to a window comfortably past the report horizon, because a day
 * the platform has long since aggregated is a fact with no remaining reader. */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Days kept locally. The reporter sends a 7-day tail; 35 keeps a month of "what did my sandbox report"
// inspectability without growing forever.
const KEEP_DAYS = 35;

const FileSchema = z.record(z.string().regex(DAY_RE), z.array(z.string()));
type ActiveUseFile = z.infer<typeof FileSchema>;

// The UTC day a moment falls on — the same YYYY-MM-DD granularity the platform's ledger and the trial's
// allowance both key on.
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

// Memoized per path so the write queue lives on ONE file object per store — two concurrent marks must not
// read the same map and let the second erase the first (the extension-usage.ts precedent).
const files = new Map<string, JsonFile<ActiveUseFile>>();

const activeUseFile = (root: string): JsonFile<ActiveUseFile> => {
    const path = statePath(root, ".intentic/extension-active-use.json");
    const existing = files.get(path);
    if (existing !== undefined) {
        return existing;
    }
    const file = jsonFile<ActiveUseFile>(path, { parse: (raw) => FileSchema.safeParse(raw).data, fallback: () => ({}) });
    files.set(path, file);
    return file;
};

const cutoff = (today: string, days: number): string => {
    const at = new Date(`${today}T00:00:00.000Z`);
    at.setUTCDate(at.getUTCDate() - (days - 1));
    return utcDay(at);
};

// Mark an extension active on a day. Idempotent — a day bit either exists or it doesn't — and every write
// sweeps days that have aged out of the keep window.
export const markExtensionActive = async (root: string, extensionId: string, day: string): Promise<void> => {
    const oldest = cutoff(day, KEEP_DAYS);
    await activeUseFile(root).update((all) => {
        const next: ActiveUseFile = {};
        for (const [seen, ids] of Object.entries(all)) {
            if (seen >= oldest) {
                next[seen] = ids;
            }
        }
        const ids = next[day] ?? [];
        next[day] = ids.includes(extensionId) ? ids : [...ids, extensionId];
        return next;
    });
};

export interface ActiveUseRow {
    readonly extensionId: string;
    readonly day: string;
}

// The rows of the last `days` days ending at `today` — what a report sends. Re-sending a row is harmless by
// design (the platform upserts on a unique key), so the reader keeps no "already reported" bookkeeping.
export const recentActiveUse = async (root: string, days: number, today: string): Promise<ActiveUseRow[]> => {
    const oldest = cutoff(today, days);
    const all = await activeUseFile(root).read();
    return Object.entries(all)
        .filter(([day]) => day >= oldest && day <= today)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .flatMap(([day, ids]) => ids.map((extensionId) => ({ extensionId, day })));
};

export interface UseNoter {
    // Note that an extension did user-driven work just now. Synchronous and unconditionally cheap: the
    // premium check and the write happen once per extension per day; every later call is a Set lookup.
    readonly note: (extensionId: string) => void;
}

/* The noter both observation points call — the UI's usage-report route and the /x backend proxy, the two
 * places an extension's user-driven activity already passes. It resolves the id to its capability and marks
 * a day bit ONLY for `tier: "premium"` installs, so the decision of what is pool-relevant (and what may
 * therefore leave the sandbox) is made here, once, rather than at each call site.
 *
 * Fire-and-forget on purpose: a mark rides the request path of somebody's extension call, and a day bit is
 * not worth failing or slowing that call for. A lost mark costs at most one day's credit, and the next call
 * that day retries it (the dedupe key is only added on success). */
export const createUseNoter = (
    root: string,
    capabilityOf: (id: string) => Promise<Capability | undefined>,
    now: () => Date = () => new Date(),
): UseNoter => {
    const seen = new Set<string>();
    return {
        note: (extensionId: string): void => {
            const day = utcDay(now());
            const key = `${day}:${extensionId}`;
            if (seen.has(key)) {
                return;
            }
            void (async () => {
                const capability = await capabilityOf(extensionId);
                if (capability?.kind !== "extension" || capability.config.tier !== "premium") {
                    // Remember the refusal too — free extensions call all day, and each call re-reading the
                    // capability file to learn "still free" is the cost this Set exists to avoid.
                    seen.add(key);
                    return;
                }
                await markExtensionActive(root, extensionId, day);
                seen.add(key);
            })().catch(() => {
                // Swallowed: the caller is somebody's extension request, and the store retries on the next call.
            });
        },
    };
};
