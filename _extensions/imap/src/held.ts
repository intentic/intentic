import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";

// Sends the owner's rules hold, kept in the backend's own state directory under the SHA-256 of exactly what will go
// out: the digest the approval pins (its `performer.digest`), so what the approvals executor hands back after a
// person's yes names one file, and a file that changed since no longer matches it.

export type Taken = { readonly kind: "held"; readonly text: string } | { readonly kind: "missing" } | { readonly kind: "changed" };

export interface HeldStore {
    // Keeps the text and answers its digest.
    readonly put: (text: string) => Promise<string>;
    readonly take: (digest: string) => Promise<Taken>;
    readonly drop: (digest: string) => Promise<void>;
}

const DIGEST = /^[0-9a-f]{64}$/;

export const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

export const heldStore = (stateDir: string): HeldStore => {
    const dir = join(stateDir, "held");
    const path = (digest: string): string => join(dir, `${digest}.json`);
    return {
        put: async (text) => {
            const digest = digestOf(text);
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await writeFile(path(digest), text, { mode: 0o600 });
            return digest;
        },
        take: async (digest) => {
            const text = DIGEST.test(digest) ? await readFile(path(digest), "utf8").catch(undefinedIfMissing) : undefined;
            if (text === undefined) {
                return { kind: "missing" };
            }
            return digestOf(text) === digest ? { kind: "held", text } : { kind: "changed" };
        },
        drop: async (digest) => {
            if (DIGEST.test(digest)) {
                await rm(path(digest), { force: true });
            }
        },
    };
};
