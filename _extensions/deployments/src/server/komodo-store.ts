import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/sandbox-contract";
import { z } from "zod";

/* When the owner last LOOKED at each Komodo connection's deployments, plus their repo→stack links
 * (<workspace>/.intentic/komodo.json) — the extension's own state file, moved here with the backend that
 * reads it. Backend-side rather than in a browser, on the same reasoning ci-store records its `seenAt`:
 * whether a breakage has been seen is a fact about the work, so clearing site data or picking up the phone
 * must not resurrect a badge already dealt with.
 *
 * Keyed by CAPABILITY id, not one timestamp for the surface: two Komodo connections are two rail tiles and
 * two separate acts of reading. Looking at staging must not silence production.
 *
 * The daemon's json-file store stayed behind (it is core plumbing, not SDK); what this keeps of it is the two
 * properties that matter at this size: a half-written or hand-mangled file reads as empty rather than
 * throwing, and updates are serialized through one queue so two rapid clicks cannot each read the same state
 * and erase the other's write. Writes go through a temp file + rename so a crash mid-write can never leave a
 * torn file where the tolerant read would silently drop everything. */

const KomodoStateSchema = z.object({
    seenAt: z.record(z.string(), z.number()),
    // capability id → (workspace repo → Komodo stack name). Nested rather than a flat "cap\nrepo" key so that
    // reading one connection's links is a lookup rather than a scan, and so removing a connection is a delete.
    links: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
type KomodoState = z.infer<typeof KomodoStateSchema>;

const EMPTY: KomodoState = { seenAt: {}, links: {} };

export interface KomodoStore {
    // Undefined until that connection's view has been opened once — which reads as "everything is news", the
    // right answer for a surface the owner has never looked at.
    readonly seenAt: (capability: string) => Promise<number | undefined>;
    readonly markSeen: (capability: string, at: number) => Promise<void>;
    // The owner's repo → stack decisions for one connection. Empty until they link something.
    readonly links: (capability: string) => Promise<Record<string, string>>;
    // An empty `stack` clears the link — the owner unlinking, or replacing one that no longer exists.
    readonly link: (capability: string, repo: string, stack: string) => Promise<void>;
}

export const komodoStorePath = (workspaceRoot: string): string => join(workspaceRoot, `${STATE_DIR}/komodo.json`);

export const fileKomodoStore = (path: string): KomodoStore => {
    const read = async (): Promise<KomodoState> => {
        try {
            return KomodoStateSchema.safeParse(JSON.parse(await readFile(path, "utf8"))).data ?? EMPTY;
        } catch {
            return EMPTY;
        }
    };
    // One queue for every mutation: read-modify-write races are the only way this file loses data.
    let queue: Promise<unknown> = Promise.resolve();
    const update = (mutate: (state: KomodoState) => KomodoState): Promise<void> => {
        const next = queue.then(async () => {
            const state = mutate(await read());
            await mkdir(dirname(path), { recursive: true });
            const staging = `${path}.tmp`;
            await writeFile(staging, `${JSON.stringify(state, undefined, 4)}\n`);
            await rename(staging, path);
        });
        // The queue survives a failed write (the next update still runs); the failure still reaches the caller.
        queue = next.catch(() => {});
        return next;
    };
    return {
        seenAt: async (capability) => (await read()).seenAt[capability],
        markSeen: (capability, at) => update((state) => ({ ...state, seenAt: { ...state.seenAt, [capability]: at } })),
        links: async (capability) => (await read()).links[capability] ?? {},
        link: (capability, repo, stack) =>
            update((state) => {
                const forCapability = { ...state.links[capability] };
                if (stack === "") {
                    delete forCapability[repo];
                } else {
                    forCapability[repo] = stack;
                }
                return { ...state, links: { ...state.links, [capability]: forCapability } };
            }),
    };
};
