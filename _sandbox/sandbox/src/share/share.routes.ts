import { randomBytes } from "node:crypto";
import { publicLabel, publicUrl, type SharedConversation, shareContract, type ShareDetail, zoneFromUrl } from "@intentic/sandbox-contract";
import { SHARE_DIR, SHARE_ID, shareId } from "@intentic/sandbox-contract/share-paths";
import { publicSlotFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { publishShare, unpublishShare, viewerDist } from "./share-publish.js";
import { shareTranscript } from "./share-payload.js";
import type { StoredShare } from "./share-store.js";

/* The /share routes: turning a conversation into a page anyone with its link can read, and taking it back.
 *
 * Every one of these is a deliberate act by the owner on one named conversation, there is no route here that
 * publishes anything by default, and nothing about a conversation changes when it is shared. What lands in the
 * outbox is a rendering (share-payload.ts decides what of it travels); the conversation itself is untouched
 * and keeps running.
 *
 * A share is FROZEN. `create` takes a snapshot, `update` takes another under the same id, and therefore the
 * same link, which has already been sent, and nothing else moves a published page. That is what makes the
 * feature safe to use on a conversation you intend to keep working in: the next turn is private until you say
 * otherwise. */

export type ShareRoutesDeps = Pick<Services, "agents" | "config" | "ensurePreviewRoutes" | "shares" | "transcripts" | "workspace">;

// 64 bits of the address, and the only thing between a stranger and the conversation, see share-paths.ts.
const RANDOM_BYTES = 8;

export const createShareRoutes = (services: ShareRoutesDeps) => {
    const i = implement(shareContract).$context<OrpcContext>();
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    const slot = publicSlotFromToken(services.config.connectToken);
    const base = publicUrl(slot, zone, sandboxId);

    // A share's address. Trailing slash: the page is `<id>/index.html`, and the outbox serves a directory's
    // index (public-files.ts rule 4), so the link people paste names the conversation, not a file.
    const urlOf = (id: string): string | undefined => (base === undefined ? undefined : `${base}/${SHARE_DIR}/${encodeURIComponent(id)}/`);
    const withUrl = (share: StoredShare): SharedConversation => {
        const url = urlOf(share.id);
        return url === undefined ? share : { ...share, url };
    };

    /* Take the snapshot and write the page. The one path both create and update run, because they differ only
     * in where the id comes from, which is exactly the difference between a new link and the one already in
     * somebody's messages. */
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
        // Resolved here, per share, rather than when these routes are built, see viewerDist. A sandbox image
        // that somehow shipped without the page bundle fails this one call with a message the owner can act
        // on, instead of failing to boot.
        let viewer: string;
        try {
            viewer = viewerDist();
        } catch {
            throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "this sandbox image is missing the shared-conversation page" });
        }
        await publishShare(services.workspace.root, viewer, id, { title, sharedAt, detail, messages }, pictures);
        // Almost always a memoized no-op, the boot sweep pre-mints the outbox label. It pays a platform call
        // only when boot ran with the platform unreachable, which is exactly when the first share would
        // otherwise hand out a hostname that does not resolve. Same reasoning as the publish route's.
        await services.ensurePreviewRoutes([publicLabel(slot)]);
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
            // The stem is the user's title, so the guard is real rather than ceremonial: it is what stands
            // between a title and a directory name. A title that survives shareStem's alphabet cannot fail
            // this, which is why a failure here is a bug in the minting rather than bad input.
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
            // Title and detail level are the share's, not re-decided here: Update means "same link, same
            // terms, later state". Changing what a link shows under someone's feet is a new share.
            return snapshot(existing.id, existing.conversationId, existing.title, existing.detail);
        }),

        remove: i.remove.handler(async ({ input }) => {
            // The id addresses a directory, so it is checked before it is joined onto one, even though it can
            // only have come from this daemon's own minting.
            if (!SHARE_ID.test(input.id)) {
                throw new ORPCError("BAD_REQUEST", { message: "not a share" });
            }
            // The page goes first. A crash between the two leaves a row pointing at nothing, which the view
            // can still act on; the other order leaves a page on the internet with nothing in the app that
            // knows how to withdraw it.
            await unpublishShare(services.workspace.root, input.id);
            await services.shares.remove(input.id);
            return { ok: true } as const;
        }),
    };
};
