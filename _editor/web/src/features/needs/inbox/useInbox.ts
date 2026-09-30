import { roleAtLeast } from "@intentic/sandbox-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { computed } from "vue";
import { viewAsks } from "../../../lib/registries/viewAsks";
import { awaitingUser } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { useExtensions } from "../../extensions/useExtensions";
import { useRole } from "../../sandbox/secrets/useRole";
import { useNeeds } from "../useNeeds";
import { chatItem, type InboxItem, inboxBadge, inboxOrder, inboxSections, installItem, needItem, viewItem, waitingWakes, wakeItem } from "./inboxItems";

// The whole of Needs you, gathered from the stores that already hold each part: every read here is one the shell makes
// anyway (the needs push, the fleet roster and its held wakes, the extensions list, a view's own module state), so the
// rail tile can count it with the page closed and nothing extra is fetched to do so.
export function useInbox() {
    const { open: openNeeds } = useNeeds();
    const { fleet, agentById, heldWakes } = useAgents();
    const { pending } = useExtensions();
    const { role } = useRole();

    const items = computed<readonly InboxItem[]>(() => {
        // Letting an extension run and releasing a held wake are a maintainer's yes; the daemon refuses either press
        // below that, so neither is listed as something this reader owes.
        const maintainer = roleAtLeast(role.value, `maintainer`);
        return [
            ...openNeeds.value.map((need) => needItem(need, agentById(need.conversationId))),
            // This sandbox's own turns only: another box's card opens in that box, not in this page's chat.
            ...fleet.value
                .filter((agent) => agent.sandboxId === undefined && agent.archivedAt === undefined && (awaitingUser(agent) || agent.attention.credential))
                .map(chatItem),
            ...(maintainer ? waitingWakes(heldWakes.value).map(wakeItem) : []),
            ...(maintainer ? pending.value.map(installItem) : []),
            ...viewAsks().flatMap(({ view, asks }) => asks.map((ask) => viewItem(view, ask))),
        ];
    });

    return {
        items,
        ordered: computed(() => inboxOrder(items.value)),
        sections: computed(() => inboxSections(items.value)),
        // The rail's Needs tile reads this from ShellDesktop, and `items` rebuilds on every composer keystroke (the fleet
        // carries each chat's unsent mark). Keeping the previous object while count, tone and tooltip are unchanged is
        // what stops a keystroke from redrawing the whole shell (perf chat-typing budget).
        badge: computed<ViewBadge | undefined>((previous) => {
            const next = inboxBadge(items.value);
            return previous !== undefined &&
                next !== undefined &&
                previous.count === next.count &&
                previous.tone === next.tone &&
                previous.tooltip === next.tooltip
                ? previous
                : next;
        }),
    };
}
