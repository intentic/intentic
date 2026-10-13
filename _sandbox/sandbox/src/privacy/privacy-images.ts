import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { PRIVACY_IMAGE_ID, type PrivacyImagePair, PrivacyImagePairSchema } from "@intentic/sandbox-contract";

// The images the shield painted over, each as it was and as it left, so the owner can peek at what a provider saw in
// place of a picture (privacy.image). The picture before holds the very values the vault keeps, so it is kept where the
// vault is (mode 0600, off the workspace), and only the newest few: enough to check what the shield did lately, not an
// album of everything the agent was ever shown.

export interface PrivacyImageArchive {
    // Keeps a pair under its id once; the same image painted again is the same pair, and is not written again.
    readonly keep: (id: string, before: PrivacyImagePair["before"], after: PrivacyImagePair["after"]) => Promise<void>;
    // The pair under an id, or undefined: never kept, or since dropped for newer ones.
    readonly read: (id: string) => Promise<PrivacyImagePair | undefined>;
    // Deletes every pair kept before `before`, with the vault's own retention (settings.retention.privacyVaultDays):
    // the picture before masking holds the very values the vault ages out. Answers how many it deleted.
    readonly expire: (before: Date) => Promise<number>;
}

// A busy afternoon's screenshots; each pair is two whole pictures.
export const PRIVACY_IMAGES_KEPT = 40;

export const filePrivacyImages = (dir: string, now: () => Date = () => new Date(), kept = PRIVACY_IMAGES_KEPT): PrivacyImageArchive => {
    const written = new Set<string>();
    const fileOf = (id: string): string => join(dir, `${id}.json`);
    // Oldest first out, by when each was written.
    const prune = async (): Promise<void> => {
        const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
        if (names.length <= kept) {
            return;
        }
        const aged = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs })));
        for (const { name } of aged.toSorted((left, right) => left.at - right.at).slice(0, aged.length - kept)) {
            written.delete(name.slice(0, -".json".length));
            await rm(join(dir, name), { force: true });
        }
    };
    return {
        keep: async (id, before, after) => {
            if (!PRIVACY_IMAGE_ID.test(id) || written.has(id)) {
                return;
            }
            written.add(id);
            const exists = await stat(fileOf(id)).then(
                () => true,
                () => false,
            );
            if (exists) {
                return;
            }
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const pair: PrivacyImagePair = { at: now().toISOString(), before, after };
            await writeFile(fileOf(id), JSON.stringify(pair), { mode: 0o600 });
            await prune();
        },
        expire: async (before) => {
            const names = ((await readdir(dir).catch(undefinedIfMissing)) ?? []).filter((name) => name.endsWith(".json"));
            let removed = 0;
            for (const name of names) {
                const at = (await stat(join(dir, name)).catch(undefinedIfMissing))?.mtimeMs;
                if (at !== undefined && at < before.getTime()) {
                    written.delete(name.slice(0, -".json".length));
                    await rm(join(dir, name), { force: true });
                    removed += 1;
                }
            }
            return removed;
        },
        read: async (id) => {
            if (!PRIVACY_IMAGE_ID.test(id)) {
                return undefined;
            }
            const raw = await readFile(fileOf(id), "utf8").catch(undefinedIfMissing);
            if (raw === undefined) {
                return undefined;
            }
            try {
                return PrivacyImagePairSchema.safeParse(JSON.parse(raw)).data;
            } catch {
                // allow(silent-catch): a pair torn by a crash mid-write reads as one no longer kept.
                return undefined;
            }
        },
    };
};

// In memory, for the route suites and the request shield's tests.
export const memoryPrivacyImages = (kept = PRIVACY_IMAGES_KEPT): PrivacyImageArchive & { readonly pairs: Map<string, PrivacyImagePair> } => {
    const pairs = new Map<string, PrivacyImagePair>();
    return {
        pairs,
        keep: async (id, before, after) => {
            if (pairs.has(id)) {
                return;
            }
            pairs.set(id, { at: new Date().toISOString(), before, after });
            for (const oldest of [...pairs.keys()].slice(0, Math.max(0, pairs.size - kept))) {
                pairs.delete(oldest);
            }
        },
        read: async (id) => pairs.get(id),
        expire: async (before) => {
            const old = [...pairs].filter(([, pair]) => pair.at < before.toISOString());
            for (const [id] of old) {
                pairs.delete(id);
            }
            return old.length;
        },
    };
};
