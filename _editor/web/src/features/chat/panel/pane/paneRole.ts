import { FULL_ACCESS_ROLE, roleModels } from "@intentic/sandbox-contract/schemas/roles";
import { t } from "@intentic/ui/i18n";
import { computed, type Ref, watch } from "vue";
import { useAgents } from "../../../../models/fleet/useAgents";
import { useRoles } from "../../../../models/sandbox/roles/useRoles";
import { builtInOf, builtInRoleView, roleLabel } from "../../../../models/sandbox/roles/builtInRoles";
import { roleSources } from "../../../../models/providers/roleModel";
import type { ChatRouting } from "../../routing/chatRoute";
import type { Conversation } from "../../../../models/conversations/session/conversation";

// Who one pane's chat is to the outside world: the pick lives on the conversation (ComposerSelection.actsAs); this adds
// the card behind the id, the one state worth interrupting the composer for, and the pick itself.

export interface PaneRoleHost {
    readonly conversation: () => Conversation;
    // A pick by hand overrules whatever the router read into this chat.
    readonly route: Pick<ChatRouting, "byHand">;
    readonly isGuest: Readonly<Ref<boolean>>;
    // Closes the picker the pick was made in.
    readonly picked: () => void;
}

export const usePaneRole = (host: PaneRoleHost) => {
    const { conversation } = host;
    const { roles, isConnected: roleSignedIn } = useRoles();
    const pickedRole = computed(() => roles.value.find((role) => role.id === conversation().selection.actsAs.value));
    // Never blank: no pick is All accounts, a built-in is named, and a card that is gone shows its id.
    const roleName = computed(() => roleLabel(conversation().selection.actsAs.value, roles.value));
    // The pill's mark when no card's face stands in: the built-in's own.
    const roleIcon = computed(() => builtInRoleView(builtInOf(conversation().selection.actsAs.value) ?? FULL_ACCESS_ROLE).icon);

    // Picking no longer moves the chat between trees: a card says where it starts and what it may touch, and the
    // role's own model goes on with it, when it has one (the `wearModel` pick).
    const pickRole = (id: string | undefined): void => {
        host.picked();
        conversation().selection.apply({ kind: `set`, picks: { actsAs: id } });
        host.route.byHand();
        const picked = roles.value.find((role) => role.id === id);
        const head = picked === undefined ? undefined : roleModels(picked, roleSources.value)[0];
        if (head !== undefined) {
            conversation().selection.apply({ kind: `wearModel`, pin: head });
        }
    };

    // A person can switch the conversation to another role on a card (a grant need offering the roles whose access
    // has what the agent asked for): its next turn wears it, and its summary says so (`lastActsAs`). The pill follows that
    // move, so this pane's next message keeps the role rather than sending its old pick back. Only a move is followed:
    // a turn wearing what this pane sent changes nothing, and opening a conversation keeps the pick it was restored with.
    const { agentById } = useAgents();
    const worn = computed(() => agentById(conversation().conversationId)?.lastActsAs);
    watch(worn, (next, before) => {
        if (next === undefined || next === before) {
            return;
        }
        // All accounts is what no pick means, so following it to there clears the pick.
        const actsAs = next === FULL_ACCESS_ROLE ? undefined : next;
        if (actsAs !== conversation().selection.actsAs.value) {
            conversation().selection.apply({ kind: `set`, picks: { actsAs } });
        }
    });

    // A guest's chat wears one of its cards from the first word, since the daemon refuses it a turn that names none;
    // the list it is shown is already only its own cards.
    watch(
        [roles, host.isGuest],
        () => {
            const first = roles.value[0];
            if (host.isGuest.value && conversation().selection.actsAs.value === undefined && first !== undefined) {
                pickRole(first.id);
            }
        },
        { immediate: true },
    );

    return {
        roles,
        pickedRole,
        roleName,
        roleIcon,
        pickRole,
        // A missing card fails closed daemon-side (no accounts, no tools); a card with no accounts is a chosen state the
        // pill shows. What remains is a card whose accounts are not signed in.
        roleNotice: computed<string | undefined>(() => {
            const pinned = conversation().selection.actsAs.value;
            // A built-in is always there and names its own reach in the menu; nothing to interrupt the composer for.
            if (builtInOf(pinned) !== undefined) {
                return undefined;
            }
            if (pickedRole.value === undefined) {
                return t(`chat.paneRole.roleGone`, { name: pinned });
            }
            return pickedRole.value.capabilities.length === 0 || pickedRole.value.capabilities.some((held) => roleSignedIn(held))
                ? undefined
                : t(`chat.paneRole.roleNotSignedIn`, { name: roleName.value });
        }),
    };
};
