import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// When the owner last LOOKED at each Komodo connection's deployments (<workspace>/.intentic/komodo.json).
// Daemon-side rather than in a browser, on the same reasoning ci-store records its `seenAt`: whether a
// breakage has been seen is a fact about the work, so clearing site data or picking up the phone must not
// resurrect a badge already dealt with.
//
// Keyed by CAPABILITY id, not one timestamp for the surface: two Komodo connections are two rail tiles and
// two separate acts of reading. Looking at staging must not silence production.
//
// No secret lives here, so unlike ci.json this file needs no denylist entry — it is a map of ids to numbers.

const KomodoStateSchema = z.object({ seenAt: z.record(z.string(), z.number()) });
type KomodoState = z.infer<typeof KomodoStateSchema>;

export interface KomodoStore {
    // Undefined until that connection's view has been opened once — which reads as "everything is news", the
    // right answer for a surface the owner has never looked at.
    readonly seenAt: (capability: string) => Promise<number | undefined>;
    readonly markSeen: (capability: string, at: number) => Promise<void>;
}

export const fileKomodoStore = (path: string): KomodoStore => {
    const file = jsonFile<KomodoState>(path, {
        parse: (raw) => KomodoStateSchema.safeParse(raw).data,
        fallback: () => ({ seenAt: {} }),
    });
    return {
        seenAt: async (capability) => (await file.read()).seenAt[capability],
        markSeen: async (capability, at) => {
            await file.update((state) => ({ seenAt: { ...state.seenAt, [capability]: at } }));
        },
    };
};
