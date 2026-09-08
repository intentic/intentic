import { z } from "zod";
import { jsonFile } from "./json-file.js";

// Tracks whether an embed snippet is actually loading, per origin, to tell an unconfigured automation apart from one
// whose origin isn't allowlisted. Shared by the Front Desk widget and the bug-reporter SDK, one file per caller since
// automation ids aren't unique across the two.

const ProbeSchema = z.object({
    // Whether this origin was admitted; a refused probe is the actionable case, a site asking to be let in.
    allowed: z.boolean(),
    lastSeenAt: z.number(),
    // Approximate load count from this origin; distinguishes test traffic from live traffic, not an analytics figure.
    loads: z.number(),
});
export type InstallProbe = z.infer<typeof ProbeSchema> & { origin: string };

const FileSchema = z.record(z.string(), z.record(z.string(), ProbeSchema));
type InstallsFile = z.infer<typeof FileSchema>;

// Diagnostic counts are flushed on this timer instead of per write; a crash loses at most this many seconds of counts.
const FLUSH_MS = 30_000;

// Origins beyond this are evicted least-recently-seen first, so an actively-installing site's entry is kept.
const MAX_ORIGINS_PER_AUTOMATION = 20;

export interface InstallsStore {
    // Records one script load; `allowed` is the decision actually made, not re-derived from the current allowlist.
    readonly record: (automationId: string, origin: string, allowed: boolean, now: number) => void;
    // Newest first, as rendered by the install panel.
    readonly list: (automationId: string) => Promise<InstallProbe[]>;
    // Flushes now and stops the timer; for tests and shutdown, ordinary use never calls it.
    readonly flush: () => Promise<void>;
}

export const fileInstallsStore = (path: string): InstallsStore => {
    const file = jsonFile<InstallsFile>(path, {
        parse: (raw) => FileSchema.safeParse(raw).data,
        fallback: () => ({}),
    });

    // Undefined until the first read or record pulls the file in, so an automation nobody visits never touches this
    // file.
    let memory: InstallsFile | undefined;
    let timer: NodeJS.Timeout | undefined;

    // Serializes every read and write so a panel opened right after a page load never reads ahead of that load's write.
    let tail: Promise<unknown> = Promise.resolve();
    const queue = <T>(work: (all: InstallsFile) => T): Promise<T> => {
        const next = tail.then(async () => {
            memory ??= await file.read();
            return work(memory);
        });
        // Caught only to keep the chain alive after a failure; the caller still sees its own rejection.
        tail = next.catch(() => undefined);
        return next;
    };

    const flush = async (): Promise<void> => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        const snapshot = memory;
        if (snapshot === undefined) {
            return;
        }
        await file.update(() => snapshot);
    };

    return {
        record: (automationId, origin, allowed, now) => {
            void queue((all) => {
                const forAutomation = all[automationId] ?? {};
                const existing = forAutomation[origin];
                forAutomation[origin] = { allowed, lastSeenAt: now, loads: (existing?.loads ?? 0) + 1 };
                all[automationId] = evictOldest(forAutomation);
                timer ??= setTimeout(() => void flush(), FLUSH_MS);
                // Never holds the daemon open on a diagnostic write.
                timer.unref?.();
            });
        },
        list: async (automationId) =>
            queue((all) =>
                Object.entries(all[automationId] ?? {})
                    .map(([origin, probe]) => ({ origin, allowed: probe.allowed, lastSeenAt: probe.lastSeenAt, loads: probe.loads }))
                    .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt),
            ),
        flush,
    };
};

const evictOldest = (origins: Record<string, z.infer<typeof ProbeSchema>>): Record<string, z.infer<typeof ProbeSchema>> => {
    const entries = Object.entries(origins);
    if (entries.length <= MAX_ORIGINS_PER_AUTOMATION) {
        return origins;
    }
    return Object.fromEntries(entries.toSorted(([, a], [, b]) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_ORIGINS_PER_AUTOMATION));
};
