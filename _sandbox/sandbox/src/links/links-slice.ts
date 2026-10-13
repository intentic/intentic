import { join } from "node:path";
import type { Logger } from "pino";
import type { Services } from "../composition.js";
import { turnStandingOf } from "../conversations/actor/turn-standing.js";
import { conversationProfile } from "../conversations/registry/agents-store.js";
import { fileInboundLinks, type InboundLinks, inboundLinksDocument } from "./inbound-links.js";
import { createLinkedChildren, type LinkedChildren, linkedChildrenDocument } from "./linked-children.js";

// LINKED SANDBOXES, both halves: the other sandboxes allowed to hand this one tasks, and the tasks this one handed to
// others. Either half works without the other; a sandbox is usually one side of a given link and may be both.
export interface LinksSlice {
    // Inbound: links this sandbox's owner minted for other sandboxes, each with the terms its tasks run under here.
    readonly inboundLinks: InboundLinks;
    // Outbound: tasks this sandbox's agents handed over through `link` cards, followed until they settle.
    readonly linkedChildren: LinkedChildren;
}

export const createLinksSlice = ({
    historyRoot,
    logger,
    whole,
}: {
    readonly historyRoot: string;
    readonly logger: Logger;
    readonly whole: () => Services;
}): LinksSlice => {
    const inboundLinks = fileInboundLinks(join(historyRoot, inboundLinksDocument.path));
    // Read through `whole` at call time: the registry, the turns and the capabilities are composed after this slice.
    const linkedChildren = createLinkedChildren({
        capabilities: () => whole().capabilities.list(),
        conversations: {
            holdings: (holding) => whole().conversations.holdings(holding),
            send: (conversationId, message) => whole().conversations.send(conversationId, message),
        },
        standingOf: (conversationId) => turnStandingOf(whole().conversations, conversationId),
        entryOf: (conversationId) => {
            const entry = whole().agents.entry(conversationId);
            return entry === undefined ? undefined : { startedBy: entry.identity.startedBy, title: entry.social.title?.text };
        },
        profileOf: (conversationId) => {
            const entry = whole().agents.entry(conversationId);
            return entry === undefined ? undefined : conversationProfile(entry);
        },
        inboundHops: async (conversationId) => (await inboundLinks.linkOf(conversationId))?.task.hops,
        doors: { turns: { say: (said) => whole().turns.say(said) } },
        logger,
        historyPath: join(historyRoot, linkedChildrenDocument.path),
    });
    return { inboundLinks, linkedChildren };
};
