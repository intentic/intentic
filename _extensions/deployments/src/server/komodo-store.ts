import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extensionRuntimeDir } from "@intentic/sandbox-contract";
import { z } from "zod";

// Persisted seenAt and repo→stack links per Komodo connection, backend-side since seen state is a fact about the work.
// Keyed by capability id: two connections are two separate acts of reading, so staging must not silence production.
// Tolerant read (a mangled file reads as empty), one write queue, atomic rename.

const KomodoStateSchema = z.object({
    seenAt: z.record(z.string(), z.number()),
    // capability → (repo → stack); nested so reading one connection's links is a lookup, not a scan.
    links: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
type KomodoState = z.infer<typeof KomodoStateSchema>;

const EMPTY: KomodoState = { seenAt: {}, links: {} };

export interface KomodoStore {
    // Undefined until that connection's view has opened once; reads as everything being news until then.
    readonly seenAt: (capability: string) => Promise<number | undefined>;
    readonly markSeen: (capability: string, at: number) => Promise<void>;
    // The owner's repo → stack decisions for one connection. Empty until they link something.
    readonly links: (capability: string) => Promise<Record<string, string>>;
    // An empty `stack` clears the link, whether unlinking or replacing one that no longer exists.
    readonly link: (capability: string, repo: string, stack: string) => Promise<void>;
}

export const komodoStorePath = (workspaceRoot: string): string => join(workspaceRoot, extensionRuntimeDir("deployments"), "komodo.json");

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
