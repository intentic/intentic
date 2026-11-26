import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";
import type { z } from "zod";

// A JSON file of the workspace's records this extension keeps where the daemon kept it, in the daemon's shape: read
// whole, written whole by a rename so a reader in another process (the backend reading what the gateway wrote) never sees
// half of it, and every update in this process in arrival order.

export interface JsonFile<T> {
    read(): Promise<T>;
    update(change: (current: T) => T): Promise<T>;
}

export const jsonFile = <T>(path: string, schema: z.ZodType<T>, fallback: () => T): JsonFile<T> => {
    let chain: Promise<unknown> = Promise.resolve();
    const read = async (): Promise<T> => {
        let text: string;
        try {
            text = await readFile(path, `utf8`);
        } catch {
            // allow(silent-catch): absent is the empty record, what nobody has written to yet
            return fallback();
        }
        try {
            const parsed = schema.safeParse(JSON.parse(text));
            return parsed.success ? parsed.data : fallback();
        } catch {
            // allow(silent-catch): a file this build cannot read is started again, as the daemon's documents fall back
            return fallback();
        }
    };
    const update = (change: (current: T) => T): Promise<T> => {
        const next = chain.then(async () => {
            const current = await read();
            const changed = change(current);
            if (changed === current) {
                return current;
            }
            await mkdir(dirname(path), { recursive: true });
            await writeFileAtomic(path, `${JSON.stringify(changed, undefined, 2)}\n`);
            return changed;
        });
        // allow(silent-catch): the chain only orders the next update; this one's failure reaches its own caller through `next`
        chain = next.catch(() => undefined);
        return next;
    };
    return { read, update };
};
