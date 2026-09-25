import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { z } from "zod";
import { writeJsonFile } from "../../../store/json-file.js";

// A provider's own accounts as one `<id>.json` per account in its auth directory, each read through the provider's schema.
export interface AccountFiles<T> {
    // Only a missing file is no such account: one that cannot be read throws, and content of another shape reads as none.
    readonly read: (id: string) => Promise<T | undefined>;
    // Every file of the account's shape, oldest connection first; a foreign JSON sharing the directory is skipped.
    readonly list: () => Promise<T[]>;
    // Atomic, so a reader never sees half an account, and owner-only, since each file holds a credential.
    readonly write: (account: T) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
}

const jsonOf = (text: string): unknown => {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        // allow(silent-catch): text that is not JSON is content of another shape, which reads as no account
        return undefined;
    }
};

export const accountFiles = <T extends { readonly id: string; readonly connectedAt: number }>(dir: string, schema: z.ZodType<T>): AccountFiles<T> => {
    const path = (id: string): string => join(dir, `${id}.json`);
    const read = async (id: string): Promise<T | undefined> => {
        const text = await readFile(path(id), "utf8").catch(undefinedIfMissing);
        if (text === undefined) {
            return undefined;
        }
        const parsed = schema.safeParse(jsonOf(text));
        return parsed.success ? parsed.data : undefined;
    };
    return {
        read,
        list: async () => {
            const names = (await readdir(dir).catch(undefinedIfMissing)) ?? [];
            const stored = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => read(name.slice(0, -".json".length))));
            return stored.filter((account): account is Awaited<T> => account !== undefined).toSorted((a, b) => a.connectedAt - b.connectedAt);
        },
        write: (account) => writeJsonFile(path(account.id), account, 0o600),
        remove: async (id) => {
            await rm(path(id), { force: true });
        },
    };
};
