import { randomBytes } from "node:crypto";
import { publicUrl, type SharedConversation, shareContract, type ShareDetail, zoneFromUrl } from "@intentic/sandbox-contract";
import { SHARE_DIR, SHARE_ID, shareId } from "@intentic/sandbox-contract/share-paths";
import { publicSlotFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { publishShare, unpublishShare, viewerDist } from "./share-publish.js";
import { shareTranscript } from "./share-payload.js";
import type { StoredShare } from "./share-store.js";

// Turns a conversation into a page anyone with the link can read, and takes it back; every route is a deliberate act on
// one named conversation, and nothing about the live conversation changes when it's shared. A share is frozen: `create`
// and `update` snapshot under the same id and link, and nothing else moves a published page, so the next turn stays
// private until asked.

export type ShareRoutesDeps = Pick<Services, "agents" | "config" | "shares" | "transcripts" | "workspace">;

// 64 bits of the share address, the only thing between a stranger and the conversation (share-paths.ts).
const RANDOM_BYTES = 8;

export const createShareRoutes = (services: ShareRoutesDeps) => {
    const i = implement(shareContract).$context<OrpcContext>();
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    const slot = publicSlotFromToken(services.config.connectToken);
    const base = publicUrl(slot, zone, sandboxId);

    // Trailing slash, since the page is `<id>/index.html`, and the outbox serves a directory's index; the link names
    // the conversation, not a file.
    const urlOf = (id: string): string | undefined => (base === undefined ? undefined : `${base}/${SHARE_DIR}/${encodeURIComponent(id)}/`);
    const withUrl = (share: StoredShare): SharedConversation => {
        const url = urlOf(share.id);
        return url === undefined ? share : { ...share, url };
    };

    // Takes the snapshot and writes the page; the one path both create and update run, differing only in where the id
    // comes from.
    const snapshot = async (id: string, conversationId: string, title: string, detail: ShareDetail): Promise<SharedConversation> => {
        const agent = services.agents.entry(conversationId);
        if (agent === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "unknown conversation" });
        }
        const { messages, pictures } = shareTranscript(await services.transcripts.read(agent), detail);
        if (messages.length === 0) {
            throw new ORPCError("BAD_REQUEST", { message: "this conversation has nothing to share yet" });
        }
        const sharedAt = Date.now();
        // Resolved per share, not at route build time, so a sandbox image missing the page bundle fails one call with a
        // message instead of failing to boot.
        let viewer: string;
        try {
            viewer = viewerDist();
        } catch {
            throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "this sandbox image is missing the shared-conversation page" });
        }
        await publishShare(services.workspace.root, viewer, id, { title, sharedAt, detail, messages }, pictures);
        const stored: StoredShare = { id, conversationId, title, detail, sharedAt, messages: messages.length };
        await services.shares.put(stored);
        return withUrl(stored);
    };

    return {
        list: i.list.handler(async () => ({ shares: (await services.shares.all()).map(withUrl) })),

        create: i.create.handler(async ({ input }) => {
            const title = input.title.trim();
            if (title === "") {
                throw new ORPCError("BAD_REQUEST", { message: "a shared conversation needs a title" });
            }
            const id = shareId(title, randomBytes(RANDOM_BYTES).toString("hex"));
            // Not ceremony: a title surviving shareStem's alphabet can't fail this, so a failure here is a minting bug.
            if (!SHARE_ID.test(id)) {
                throw new ORPCError("BAD_REQUEST", { message: "that title can't be used as a link name" });
            }
            return snapshot(id, input.conversationId, title, input.detail);
        }),

        update: i.update.handler(async ({ input }) => {
            const existing = await services.shares.get(input.id);
            if (existing === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown share" });
            }
            // Title and detail are the share's own; update means the same link and terms, later state.
            return snapshot(existing.id, existing.conversationId, existing.title, existing.detail);
        }),

        remove: i.remove.handler(async ({ input }) => {
            // Checked before being joined into a path, even though it can only ever be this daemon's own minted id.
            if (!SHARE_ID.test(input.id)) {
                throw new ORPCError("BAD_REQUEST", { message: "not a share" });
            }
            // Page removed first: a crash after leaves a dangling row, not a live page nothing can withdraw.
            await unpublishShare(services.workspace.root, input.id);
            await services.shares.remove(input.id);
            return { ok: true } as const;
        }),
    };
};
