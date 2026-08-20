import { jsonFile } from "../store/json-file.js";
import { z } from "zod";
import { statePath } from "../workspace/state-paths.js";

/* Did the snippet actually land on the site?
 *
 * Until this existed the app could not tell "installed correctly, nobody has written yet" from "the snippet was
 * never pasted" or "it was pasted on an origin the allowlist doesn't have", all three are an automation with no
 * runs, and the middle one is the single likeliest setup mistake (www.example.com and example.com are different
 * origins, and a site that redirects one to the other still loads the widget from whichever the browser was on).
 *
 * Every widget load fetches /webchat/<id>/config, so that request is the probe. Recording it turns the silence
 * into an answer, and recording the REFUSED ones turns the commonest mistake into a sentence naming the origin
 * to add. */

const ProbeSchema = z.object({
    // Whether this origin was admitted. A refused probe is the useful one, it is a site asking to be let in.
    allowed: z.boolean(),
    lastSeenAt: z.number(),
    // Widget loads seen from this origin. Approximate by design (see the flush note below); it is here to
    // distinguish "one page load while testing" from "this is live", not to be an analytics number.
    loads: z.number(),
});
export type WebchatInstallProbe = z.infer<typeof ProbeSchema> & { origin: string };

const FileSchema = z.record(z.string(), z.record(z.string(), ProbeSchema));
type InstallsFile = z.infer<typeof FileSchema>;

/* A busy site loads the widget on every page view, so writing per probe would be a write storm on the workspace
 * volume for information nobody is watching second-by-second. The map is authoritative in memory and flushed on
 * a timer, which means a daemon killed inside the window loses at most this many seconds of counts, an
 * acceptable trade for a diagnostic, and the reason `loads` is documented as approximate. */
const FLUSH_MS = 30_000;

// Bound both dimensions. Origins are evicted least-recently-seen first, so the site someone is actively
// installing on is never the one dropped.
const MAX_ORIGINS_PER_AUTOMATION = 20;

export interface WebchatInstallsStore {
    // One widget load. `allowed` is the admission decision that was actually made, so the panel reports what
    // happened rather than re-deriving it from a list that may have been edited since.
    readonly record: (automationId: string, origin: string, allowed: boolean, now: number) => void;
    // Newest first, what the install panel renders.
    readonly list: (automationId: string) => Promise<WebchatInstallProbe[]>;
    // Flush now and stop the timer. For tests and shutdown; ordinary use never calls it.
    readonly flush: () => Promise<void>;
}

export const fileWebchatInstallsStore = (root: string): WebchatInstallsStore => {
    const file = jsonFile<InstallsFile>(statePath(root, ".intentic/records/webchat-installs.json"), {
        parse: (raw) => FileSchema.safeParse(raw).data,
        fallback: () => ({}),
    });

    // undefined until the first read/record pulls the file in, so a daemon whose Front Desks nobody visits never
    // touches this file at all.
    let memory: InstallsFile | undefined;
    let timer: NodeJS.Timeout | undefined;

    /* Every mutation and every read rides this one chain. `record` is called from a request handler that must
     * not wait on a diagnostic, so it cannot be awaited, but the panel is opened moments after the page load
     * it is asking about, and a read that overtook the write it is looking for would report the exact silence
     * this store exists to end. Serializing both is what makes "reload your site, then look" reliable. */
    let tail: Promise<unknown> = Promise.resolve();
    const queue = <T>(work: (all: InstallsFile) => T): Promise<T> => {
        const next = tail.then(async () => {
            memory ??= await file.read();
            return work(memory);
        });
        // A failed probe must not poison the chain for the next one; the caller still sees its own rejection.
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
                // Never hold the daemon open on a diagnostic write.
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
