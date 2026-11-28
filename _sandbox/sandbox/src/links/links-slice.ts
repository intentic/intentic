import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { TurnLease } from "../agent/tools/turn-mounts.js";
import type { Logger } from "pino";
import type { CompositionCore, Services } from "../composition.js";
import { turnStandingOf } from "../conversations/actor/turn-standing.js";
import { conversationProfile } from "../conversations/registry/agents-store.js";
import { defineSlice } from "../seams/slice.js";
import { fileInboundLinks, type InboundLinks, inboundLinksDocument } from "./inbound-links.js";
import { createLinkedChildren, type LinkedChildren } from "./linked-children.js";
import { linkedChildrenDocument } from "./linked-children-store.js";
import { filePersonTasks, type PersonTasksStore, personTasksDocument } from "./person-tasks-store.js";
import { linkMountsOf } from "./link-mounts.js";
import { personRoutesOf } from "./person-routes.js";
import { askerDepsOf } from "../s2s/s2s-wiring.js";
import { contactSendsOf, type ContactSendsHub } from "../s2s/tasks/asking.js";
import { contactMountsOf } from "../s2s/contacts/contact-mounts.js";
import { type ContactTasksStore, contactTasksDocument, fileContactTasks } from "./contacts/contact-tasks-store.js";
import { supervisorFor } from "../agent/subagents/children.js";
import { sdkServerDoor } from "../runtimes/daemon-tools/sdk-door.js";
import { noteLinkCardUsed } from "./upgrade/upgrade-sweep.js";

// LINKED SANDBOXES, both halves: the other sandboxes allowed to hand this one tasks, and the tasks this one handed to
// others. Either half works without the other; a sandbox is usually one side of a given link and may be both.
export interface LinksSlice {
    // Inbound: links this sandbox's owner minted for other sandboxes, each with the terms its tasks run under here.
    readonly inboundLinks: InboundLinks;
    // Inbound too: the tasks other sandboxes routed here as one of their people (person-tasks.ts), keyed by (sandbox, person).
    readonly personTasks: PersonTasksStore;
    // Inbound too: the tasks sandbox-scoped contacts handed this one as messages (links/contacts/), keyed by contact.
    readonly contactTasks: ContactTasksStore;
    // Outbound to contacts: the `task.*` messages this sandbox's agents send, each one's first attempt waited on.
    readonly contactSends: ContactSendsHub;
    // Outbound: tasks this sandbox's agents handed over through `link` cards, followed until they settle.
    readonly linkedChildren: LinkedChildren;
    // A turn's linked sandboxes as tool servers on its lease, one per granted card, as its computers are mounted.
    readonly linkMounts: (granted: readonly Capability[], lease: Pick<TurnLease, "open">, conversationId: string | undefined) => AgentTool[];
    // A turn's contacts as tool servers on its lease, one per contact it may use (s2s/contacts/contact-mounts.ts).
    // `taken`: every other server name the turn mounts, which no contact's server may take (s2s/contacts/contact-mounts.ts).
    readonly contactMounts: (granted: readonly Capability[], lease: Pick<TurnLease, "open">, conversationId: string | undefined, taken?: ReadonlySet<string>) => Promise<AgentTool[]>;
}

const createLinksSlice = ({
    historyRoot,
    logger,
    whole,
}: {
    readonly historyRoot: string;
    readonly logger: Logger;
    readonly whole: () => Services;
}): LinksSlice => {
    const inboundLinks = fileInboundLinks(join(historyRoot, inboundLinksDocument.path));
    const personTasks = filePersonTasks(join(historyRoot, personTasksDocument.path));
    const contactTasks = fileContactTasks(join(historyRoot, contactTasksDocument.path));
    const contactSends = contactSendsOf({ contacts: () => whole().s2s.contacts, outbox: () => whole().s2s.outbox, askers: () => askerDepsOf(whole()) });
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
        // Over a link, routed as a person, or handed by a contact alike: each counts toward LINK_MAX_HOPS (2026-11-24, 11-27).
        inboundHops: async (conversationId) =>
            ((await inboundLinks.linkOf(conversationId)) ?? (await contactTasks.linkOf(conversationId)) ?? (await personTasks.ownerOf(conversationId)))?.task.hops,
        doors: { turns: { say: (said) => whole().turns.say(said) } },
        logger,
        historyPath: join(historyRoot, linkedChildrenDocument.path),
        personRoutes: personRoutesOf(whole),
        contacts: contactSends,
    });
    const linkMounts: LinksSlice["linkMounts"] = (granted, lease, conversationId) => {
        // A card's use offers its far side the upgrade into a contact again (upgrade/upgrade-sweep.ts).
        for (const capability of granted.filter((card) => card.kind === "link")) {
            noteLinkCardUsed(capability.id);
        }
        return linkMountsOf({ conversations: { holdings: (holding) => whole().conversations.holdings(holding) }, about: linkedChildren.about }, granted, lease, conversationId);
    };
    const contactMounts: LinksSlice["contactMounts"] = (granted, lease, conversationId, taken) =>
        contactMountsOf(
            {
                usable: contactSends.usable,
                supervisorOf: (id) => supervisorFor(whole().conversations, id),
                door: sdkServerDoor,
                call: (row, method, input, signal) => whole().s2s.calls.client.call(row, method, input, signal),
            },
            granted,
            lease,
            conversationId,
            taken,
        );
    return { inboundLinks, personTasks, contactTasks, contactSends, linkedChildren, linkMounts, contactMounts };
};

export const linksSlice = defineSlice<LinksSlice>({
    build: ({ config, logger, whole }: Pick<CompositionCore, "config" | "logger" | "whole">) =>
        createLinksSlice({ historyRoot: config.historyRoot, logger, whole }),
});
