import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { TurnLease } from "../agent/tools/turn-mounts.js";
import type { Logger } from "pino";
import type { Services } from "../composition.js";
import { turnStandingOf } from "../conversations/actor/turn-standing.js";
import { conversationProfile } from "../conversations/registry/agents-store.js";
import { fileInboundLinks, type InboundLinks, inboundLinksDocument } from "./inbound-links.js";
import { createLinkedChildren, type LinkedChildren, linkedChildrenDocument } from "./linked-children.js";
import { linkMountsOf } from "./link-mounts.js";

// LINKED SANDBOXES, both halves: the other sandboxes allowed to hand this one tasks, and the tasks this one handed to
// others. Either half works without the other; a sandbox is usually one side of a given link and may be both.
export interface LinksSlice {
    // Inbound: links this sandbox's owner minted for other sandboxes, each with the terms its tasks run under here.
    readonly inboundLinks: InboundLinks;
    // Outbound: tasks this sandbox's agents handed over through `link` cards, followed until they settle.
    readonly linkedChildren: LinkedChildren;
    // A turn's linked sandboxes as tool servers on its lease, one per granted card, as its computers are mounted.
    readonly linkMounts: (granted: readonly Capability[], lease: Pick<TurnLease, "open">, conversationId: string | undefined) => AgentTool[];
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
    const linkMounts: LinksSlice["linkMounts"] = (granted, lease, conversationId) =>
        linkMountsOf({ conversations: { holdings: (holding) => whole().conversations.holdings(holding) }, about: linkedChildren.about }, granted, lease, conversationId);
    return { inboundLinks, linkedChildren, linkMounts };
};
