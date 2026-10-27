import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { queueOnFile } from "@intentic/base/fs";
import { parseJsonWith } from "@intentic/base/json";
import { writeSecretFile } from "@intentic/local-agent";
import { canonicalEgressOwnerKeysJson, type EgressOwnerKeys, EgressOwnerKeysSchema } from "@intentic/sandbox-contract/schemas/egress";
import { z } from "zod";
import { baseDir } from "../../config.js";

/* THE OWNER'S PASSKEYS, AS THIS MACHINE KNOWS THEM, one entry per sandbox (2026-10-27). A change that loosens a sandbox's
   egress fence arrives through that sandbox's own daemon, which is inside the fence, so the daemon's word about whose
   passkeys count cannot be what decides it. The first `set-egress` that carries owner keys pins them here (trust on
   first use); from then on a loosening must be signed by a pinned key, and only such a signature moves the pin to the
   owner's current passkeys. Kept in the agent's own state, never in a sandbox, and keyed by slug AND the sandbox's id
   from its connect token, so a sandbox removed and made again under the same name starts unpinned rather than
   inheriting a stranger's trust. Shown and reset by `intentic-machine egress trust` (egress/trust-command.ts). */

export const egressPinsPath = join(baseDir, "egress-pins.json");

const EgressPinSchema = z.object({
    slug: z.string().min(1),
    // The 12-hex id from the sandbox's connect token, as `ic sandbox list --json` reports it; null for a sandbox without one.
    sandboxId: z.string().nullable(),
    owner: EgressOwnerKeysSchema,
    // The highest signature counter each pinned key has reported, for a key that counts (a synced passkey reports 0).
    counters: z.record(z.string(), z.int().nonnegative()),
    pinnedAt: z.number(),
    // Which link's daemon handed the keys over first: the sandbox URL.
    pinnedBy: z.string(),
    replacedAt: z.number().optional(),
});
export type EgressPin = z.infer<typeof EgressPinSchema>;

const EgressPinsFileSchema = z.object({ v: z.literal(1), pins: z.array(EgressPinSchema) });
type EgressPinsFile = z.infer<typeof EgressPinsFileSchema>;

// Which sandbox a pin belongs to: the slug, and the id that tells two sandboxes of one name apart.
export interface PinnedSandbox {
    readonly slug: string;
    readonly sandboxId: string | null;
}

export interface EgressPinStore {
    // The pin for exactly this sandbox; undefined for none, or for a pin left by an earlier sandbox of the same slug.
    readonly read: (sandbox: PinnedSandbox) => Promise<EgressPin | undefined>;
    // Every pin under the slug, whichever sandbox made it (the command shows them all).
    readonly list: (slug?: string) => Promise<readonly EgressPin[]>;
    // Replaces whatever is held for the slug with this pin.
    readonly write: (pin: EgressPin) => Promise<void>;
    // Drops every pin under the slug; answers how many there were.
    readonly reset: (slug: string) => Promise<number>;
}

// Whether two owner-key sets are the same, compared in their one spelling.
export const sameOwnerKeys = (a: EgressOwnerKeys, b: EgressOwnerKeys): boolean => canonicalEgressOwnerKeysJson(a) === canonicalEgressOwnerKeysJson(b);

// Whether `next` only takes away from `pinned`: the same rpId, no origin and no passkey the pin does not already hold.
// A pin may narrow from any door (a passkey the owner deleted drops off), and only ever grows on this machine itself
// (`intentic-machine egress trust <slug> --reset`, then the next tightening pins again): the key list a loosening's
// signature covers is the daemon's word, and a daemon that could add a key of its own to it would hold the pin.
export const narrowsOwnerKeys = (next: EgressOwnerKeys, pinned: EgressOwnerKeys): boolean => {
    const keyText = (key: EgressOwnerKeys["keys"][number]): string => canonicalEgressOwnerKeysJson({ rpId: "", origins: [""], keys: [{ ...key, name: undefined }] });
    const held = new Set(pinned.keys.map(keyText));
    return next.rpId === pinned.rpId && next.origins.every((origin) => pinned.origins.includes(origin)) && next.keys.every((key) => held.has(keyText(key)));
};

// A file that is there and does not read as pins throws: every caller acts on emptiness (a pin it would write over), so
// an unreadable store is never read as "nothing pinned".
const readFileOf = async (path: string): Promise<EgressPinsFile> => {
    const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    });
    if (raw === undefined) {
        return { v: 1, pins: [] };
    }
    const parsed = parseJsonWith(raw, EgressPinsFileSchema);
    if (parsed === undefined) {
        throw new Error(`${path} does not read as this agent's passkey pins. Move it aside and pin again, or restore it from a backup.`);
    }
    return parsed;
};

// The store over one file: every write is read-modify-write in turn, so two links pinning at once both land.
export const egressPinStore = (path: string = egressPinsPath, dir: string = baseDir): EgressPinStore => {
    const update = async <T>(change: (file: EgressPinsFile) => { readonly next: EgressPinsFile; readonly answer: T }): Promise<T> =>
        await queueOnFile(path, async () => {
            const { next, answer } = change(await readFileOf(path));
            await writeSecretFile(path, dir, `${JSON.stringify(next, undefined, 2)}\n`);
            return answer;
        });
    return {
        read: async ({ slug, sandboxId }) => (await readFileOf(path)).pins.find((pin) => pin.slug === slug && pin.sandboxId === sandboxId),
        list: async (slug) => (await readFileOf(path)).pins.filter((pin) => slug === undefined || pin.slug === slug),
        write: async (pin) =>
            await update((file) => ({ next: { v: 1, pins: [...file.pins.filter((held) => held.slug !== pin.slug), pin] }, answer: undefined })),
        reset: async (slug) =>
            await update((file) => ({
                next: { v: 1, pins: file.pins.filter((held) => held.slug !== slug) },
                answer: file.pins.filter((held) => held.slug === slug).length,
            })),
    };
};
