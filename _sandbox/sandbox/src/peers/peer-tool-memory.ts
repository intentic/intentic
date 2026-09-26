import { join } from "node:path";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// What each peer publishes as its tool table, kept across daemon restarts. The bridge answers `tools/list` from this
// while a peer is away (peer-routes.ts answeredLocally), and a turn composes its tool surface once, at the start: with
// nothing remembered, a browser whose laptop is shut publishes NOTHING, and a turn that cannot see a tool concludes the
// connection does not exist and goes looking for another way in. Derived data about software on somebody else's
// machine — tool names and schemas — never a credential.

// Keyed `<domain>:<peer id>`, since one file serves every door.
export interface PeerToolMemory {
    readonly get: (key: string) => unknown;
    readonly set: (key: string, tools: unknown) => void;
    // Forgets a key: a peer held under a new one (PeerHub.rekey) must leave nothing behind under the old.
    readonly delete: (key: string) => void;
}

const PeerToolsFileSchema = z.object({ peers: z.record(z.string(), z.unknown()) });
type PeerToolsFile = z.infer<typeof PeerToolsFileSchema>;

export const peerToolsDocument = defineDocument({ root: "history", path: "peer-tools.json", schema: PeerToolsFileSchema });

export const peerToolsFile = (historyRoot: string): string => join(historyRoot, peerToolsDocument.path);

export const memoryPeerTools = (): PeerToolMemory => {
    const tools = new Map<string, unknown>();
    return { get: (key) => tools.get(key), set: (key, value) => void tools.set(key, value), delete: (key) => void tools.delete(key) };
};

// Reads are synchronous (a bridge call is answering an MCP client that is waiting), so the file is hydrated into a map
// in the background at boot: a read landing before it does answers "nothing remembered", which is what an unlisted peer
// already was. A live peer's own answer always wins over the file, so hydration never overwrites what this boot learned.
export const filePeerTools = (historyRoot: string, logger: { warn: (data: object, message: string) => void }): PeerToolMemory => {
    const path = peerToolsFile(historyRoot);
    const file = openDocument(peerToolsDocument, path, { fallback: (): PeerToolsFile => ({ peers: {} }) });
    const live = memoryPeerTools();
    const forgetInFile = async (key: string): Promise<void> => {
        try {
            await file.update((current) => {
                const { [key]: _gone, ...peers } = current.peers;
                return { peers };
            });
        } catch (error) {
            logger.warn({ err: error, key }, "peers: could not forget this peer's tool list in the file");
        }
    };
    const hydrated = new Map<string, unknown>();
    // Keys forgotten this boot, so a hydration landing after the forget does not bring them back.
    const forgotten = new Set<string>();
    void file
        .read()
        .then((stored) => {
            for (const [key, tools] of Object.entries(stored.peers)) {
                if (!forgotten.has(key)) {
                    hydrated.set(key, tools);
                }
            }
        })
        .catch((err: unknown) => logger.warn({ err }, "peers: the remembered tool lists could not be read, every peer relists on its next connect"));
    return {
        get: (key) => live.get(key) ?? hydrated.get(key),
        set: (key, tools) => {
            forgotten.delete(key);
            live.set(key, tools);
            void file
                .update((current) => ({ peers: { ...current.peers, [key]: tools } }))
                .catch((err: unknown) => logger.warn({ err, key }, "peers: could not record this peer's tool list for the next boot"));
        },
        delete: (key) => {
            forgotten.add(key);
            live.delete(key);
            hydrated.delete(key);
            void forgetInFile(key);
        },
    };
};
