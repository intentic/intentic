/* `webq cache`: what the shared cache holds and the one switch that empties it. Small on purpose — the
 * cache self-expires by TTL at read time, so the only management a human ever needs is "how big is it"
 * and "start over". */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildCommand, type CommandContext } from "@stricli/core";
import { cacheClear } from "../lib/cache.js";
import { cacheDir, webqHome } from "../lib/env.js";

export const cacheCommand = buildCommand({
    docs: { brief: "Show the shared fetch cache; --clear empties it" },
    parameters: {
        flags: {
            clear: { kind: "boolean", default: false, brief: "Delete every cached fetch" },
        },
        positional: { kind: "tuple", parameters: [] },
    },
    async func(this: CommandContext, flags: { readonly clear: boolean }) {
        if (flags.clear) {
            await cacheClear();
            this.process.stdout.write("cache cleared\n");
            return;
        }
        const { entries, bytes } = await measure(cacheDir());
        this.process.stdout.write(`webq home: ${webqHome()}\ncache: ${entries} entries, ${(bytes / 1024 / 1024).toFixed(1)} MiB\n`);
    },
});

const measure = async (dir: string): Promise<{ entries: number; bytes: number }> => {
    let entries = 0;
    let bytes = 0;
    const walkDir = async (current: string): Promise<void> => {
        let names: string[];
        try {
            names = await readdir(current);
        } catch {
            return;
        }
        for (const name of names) {
            const path = join(current, name);
            const info = await stat(path).catch(() => undefined);
            if (info === undefined) {
                continue;
            }
            if (info.isDirectory()) {
                await walkDir(path);
            } else {
                entries += 1;
                bytes += info.size;
            }
        }
    };
    await walkDir(dir);
    return { entries, bytes };
};
