import { join } from "node:path";
import { z } from "zod";
import { defineDocument } from "../store/documents.js";
import { jsonFile } from "../store/json-file.js";

// What each peer publishes as its tool table, kept across daemon restarts. The bridge answers `tools/list` from this
// while a peer is away (peer-routes.ts answeredLocally), and a turn composes its tool surface once, at the start: with
// nothing remembered, a browser whose laptop is shut publishes NOTHING, and a turn that cannot see a tool concludes the
// connection does not exist and goes looking for another way in. Derived data about software on somebody else's
// machine — tool names and schemas — never a credential.

// Keyed `<domain>:<peer id>`, since one file serves every door.
export interface PeerToolMemory {
    readonly get: (key: string) => unknown;
    readonly set: (key: string, tools: unknown) => void;
}

const PeerToolsFileSchema = z.object({ peers: z.record(z.string(), z.unknown()) });
type PeerToolsFile = z.infer<typeof PeerToolsFileSchema>;

export const peerToolsDocument = defineDocument({ root: "history", path: "peer-tools.json", schema: PeerToolsFileSchema });

export const peerToolsFile = (historyRoot: string): string => join(historyRoot, "peer-tools.json");

export const memoryPeerTools = (): PeerToolMemory => {
    const tools = new Map<string, unknown>();
    return { get: (key) => tools.get(key), set: (key, value) => void tools.set(key, value) };
};

// Reads are synchronous (a bridge call is answering an MCP client that is waiting), so the file is hydrated into a map
// in the background at boot: a read landing before it does answers "nothing remembered", which is what an unlisted peer
// already was. A live peer's own answer always wins over the file, so hydration never overwrites what this boot learned.
export const filePeerTools = (historyRoot: string, logger: { warn: (data: object, message: string) => void }): PeerToolMemory => {
    const path = peerToolsFile(historyRoot);
    const file = jsonFile<PeerToolsFile>(path, {
        parse: (raw) => PeerToolsFileSchema.safeParse(raw).data,
        fallback: () => ({ peers: {} }),
        document: peerToolsDocument,
    });
    const live = memoryPeerTools();
    const hydrated = new Map<string, unknown>();
    void file
        .read()
        .then((stored) => {
            for (const [key, tools] of Object.entries(stored.peers)) {
                hydrated.set(key, tools);
            }
        })
        .catch((err: unknown) => logger.warn({ err }, "peers: the remembered tool lists could not be read, every peer relists on its next connect"));
    return {
        get: (key) => live.get(key) ?? hydrated.get(key),
        set: (key, tools) => {
            live.set(key, tools);
            void file
                .update((current) => ({ peers: { ...current.peers, [key]: tools } }))
                .catch((err: unknown) => logger.warn({ err, key }, "peers: could not record this peer's tool list for the next boot"));
        },
    };
};
