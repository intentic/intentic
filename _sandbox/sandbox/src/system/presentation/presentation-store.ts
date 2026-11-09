import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";
import { isMissing } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";

// The owner's name for this sandbox and its switcher logo, as the platform last answered them (api-contract
// PresentationSchema). Only the platform decides them; the sandbox keeps a copy so that whatever reaches it directly
// shows them while the platform is down (2026-11-09: an outage of the platform cost every client the names and logos).
// The daemon's GET /system/presentation answers it, and the machine that runs the sandbox reads it as `ic` does
// platform-row.json, through `docker cp`, so the name and logo survive with no network at all.
// A plain file rather than a converted document, for platform-row.ts's reasons: written whole, and read by a host that is
// not this build, so its shape is fixed here: `{ name, image?, digest?, at }`, `at` the ISO time the daemon heard it.
// It sits in store/, beside platform-row.ts, so whichever layer reads it next (auth/'s host scripts) need not import
// system/.

// Spelled where it is joined, as every /history path is, so the state table's coverage test sees it built.
const presentationFile = (historyRoot: string): string => join(historyRoot, "presentation.json");

export const HeldPresentationSchema = z.object({
    name: z.string(),
    // A data URL, absent for none.
    image: z.string().optional(),
    // api-contract presentationDigest over the name and logo, which an announce's `presentationDigest` is compared with.
    digest: z.string().optional(),
    at: z.string(),
});
export type HeldPresentation = z.infer<typeof HeldPresentationSchema>;

export interface PresentationStore {
    // Undefined before the platform answered once, after it said there is none, and for a file that is not one.
    readonly read: () => Promise<HeldPresentation | undefined>;
    // Writes `next` unless the copy held says the same (name, logo and digest); answers the copy held afterwards, whose
    // `at` is the earlier one when nothing was written.
    readonly keep: (next: HeldPresentation) => Promise<HeldPresentation>;
    // Removes the copy: only the platform's own answer that the sandbox has no name and no logo does this.
    readonly forget: () => Promise<void>;
}

// Whether two copies say the same, whenever each was heard: what decides a write.
export const sameCopy = (held: HeldPresentation, next: HeldPresentation): boolean =>
    held.name === next.name && held.image === next.image && held.digest === next.digest;

export const filePresentationStore = (historyRoot: string): PresentationStore => {
    const read = async (): Promise<HeldPresentation | undefined> => {
        try {
            return parseJsonWith(await readFile(presentationFile(historyRoot), "utf8"), HeldPresentationSchema);
        } catch (error) {
            if (isMissing(error)) {
                return undefined;
            }
            throw error;
        }
    };
    return {
        read,
        // Written only when it changed, so an ask that heard the same pair again rewrites nothing. A file that cannot
        // be read throws, and the caller says so rather than write over what it could not see. 0644: nothing in it is
        // a secret, and the host reads it.
        keep: async (next) => {
            const held = await read();
            if (held !== undefined && sameCopy(held, next)) {
                return held;
            }
            await writeFileAtomic(presentationFile(historyRoot), `${JSON.stringify(next)}\n`, 0o644);
            return next;
        },
        forget: async () => {
            await rm(presentationFile(historyRoot), { force: true });
        },
    };
};
