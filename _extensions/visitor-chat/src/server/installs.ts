import { join } from "node:path";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { z } from "zod";
import { jsonFile } from "./json-file.js";

// Whether the widget is actually loading, per site, to tell a chat nobody pasted apart from one whose site is not on its
// list. Kept where the daemon kept it until 2026-11-26 (`.intentic/records/webchat-installs.json`, its store/installs.ts),
// in the same shape, so the record carries over: per chat, per origin, whether it was let in, when it last loaded and
// roughly how often. Counts are flushed on a timer rather than per page load; a restart loses at most that many seconds.

export const INSTALLS_FILE = `${STATE_GROUP_DIR.records}/webchat-installs.json`;

const ProbeSchema = z.object({ allowed: z.boolean(), lastSeenAt: z.number(), loads: z.number() });
const InstallsFileSchema = z.record(z.string(), z.record(z.string(), ProbeSchema));
type InstallsFile = z.infer<typeof InstallsFileSchema>;

export type InstallProbe = z.infer<typeof ProbeSchema> & { readonly origin: string };

const FLUSH_MS = 30_000;
// Origins beyond this are evicted least recently seen first, so an actively installing site's entry is kept.
const MAX_ORIGINS_PER_CHAT = 20;

export interface InstallsStore {
    // Records one load of a chat's settings from a page; `allowed` is the decision actually made.
    readonly record: (chatId: string, origin: string, allowed: boolean, now: number) => void;
    // Newest first.
    readonly list: (chatId: string) => Promise<InstallProbe[]>;
    readonly flush: () => Promise<void>;
}

/** The probes under the workspace root `root`. */
export const fileInstallsStore = (root: string, log: (message: string) => void): InstallsStore => {
    const file = jsonFile(join(root, INSTALLS_FILE), InstallsFileSchema, (): InstallsFile => ({}));
    let memory: InstallsFile | undefined;
    let timer: NodeJS.Timeout | undefined;
    let chain: Promise<unknown> = Promise.resolve();

    // Every read and write in arrival order, so a panel opened right after a page load never reads ahead of its write.
    const serially = <T>(work: (all: InstallsFile) => T | Promise<T>): Promise<T> => {
        const next = chain.then(async () => {
            memory ??= await file.read();
            return work(memory);
        });
        // allow(silent-catch): the chain only orders the next call; this one's failure reaches its own caller through `next`
        chain = next.catch(() => undefined);
        return next;
    };

    const flush = (): Promise<void> =>
        serially(async (all) => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            await file.update(() => ({ ...all }));
        });

    return {
        record: (chatId, origin, allowed, now) => {
            void serially((all) => {
                const origins = all[chatId] ?? {};
                origins[origin] = { allowed, lastSeenAt: now, loads: (origins[origin]?.loads ?? 0) + 1 };
                const entries = Object.entries(origins);
                all[chatId] =
                    entries.length <= MAX_ORIGINS_PER_CHAT
                        ? origins
                        : Object.fromEntries(entries.toSorted(([, a], [, b]) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_ORIGINS_PER_CHAT));
                timer ??= setTimeout(() => {
                    flush().catch((error: Error) => log(`writing the widget's install probes failed: ${error.message}`));
                }, FLUSH_MS);
                timer.unref();
            });
        },
        list: (chatId) =>
            serially((all) =>
                Object.entries(all[chatId] ?? {})
                    .map(([origin, probe]) => ({ origin, ...probe }))
                    .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt),
            ),
        flush,
    };
};
