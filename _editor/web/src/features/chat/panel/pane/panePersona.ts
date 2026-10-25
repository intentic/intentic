import { FULL_ACCESS_PERSONA, personaModels } from "@intentic/sandbox-contract/schemas/personas";
import { t } from "@intentic/ui/i18n";
import { computed, type Ref, watch } from "vue";
import { usePersonas } from "../../../../models/sandbox/personas/usePersonas";
import { builtInOf, builtInPersonaView, personaLabel } from "../../../../models/sandbox/personas/builtInPersonas";
import { roleSources } from "../../../../models/providers/roleModel";
import type { ChatRouting } from "../../routing/chatRoute";
import type { Conversation } from "../../../../models/conversations/session/conversation";

// Who one pane's chat is to the outside world: the pick lives on the conversation (ComposerSelection.actsAs); this adds
// the card behind the id, the one state worth interrupting the composer for, and the pick itself.

export interface PanePersonaHost {
    readonly conversation: () => Conversation;
    // A pick by hand overrules whatever the router read into this chat.
    readonly route: Pick<ChatRouting, "byHand">;
    readonly isGuest: Readonly<Ref<boolean>>;
    // Closes the picker the pick was made in.
    readonly picked: () => void;
}

export const usePanePersona = (host: PanePersonaHost) => {
    const { conversation } = host;
    const { personas, isConnected: personaSignedIn } = usePersonas();
    const pickedPersona = computed(() => personas.value.find((persona) => persona.id === conversation().selection.actsAs.value));
    // Never blank: no pick is Full access, a built-in is named, and a card that is gone shows its id.
    const personaName = computed(() => personaLabel(conversation().selection.actsAs.value, personas.value));
    // The pill's mark when no card's face stands in: the built-in's own.
    const personaIcon = computed(() => builtInPersonaView(builtInOf(conversation().selection.actsAs.value) ?? FULL_ACCESS_PERSONA).icon);

    // Picking no longer moves the chat between trees: a card says where it starts and what it may touch, and the
    // persona's own model goes on with it, when it has one (the `wearModel` pick).
    const pickPersona = (id: string | undefined): void => {
        host.picked();
        conversation().selection.apply({ kind: `set`, picks: { actsAs: id } });
        host.route.byHand();
        const picked = personas.value.find((persona) => persona.id === id);
        const head = picked === undefined ? undefined : personaModels(picked, roleSources.value)[0];
        if (head !== undefined) {
            conversation().selection.apply({ kind: `wearModel`, pin: head });
        }
    };

    // A guest's chat wears one of its cards from the first word, since the daemon refuses it a turn that names none;
    // the list it is shown is already only its own cards.
    watch(
        [personas, host.isGuest],
        () => {
            const first = personas.value[0];
            if (host.isGuest.value && conversation().selection.actsAs.value === undefined && first !== undefined) {
                pickPersona(first.id);
            }
        },
        { immediate: true },
    );

    return {
        personas,
        pickedPersona,
        personaName,
        personaIcon,
        pickPersona,
        // A missing card fails closed daemon-side (no accounts, no tools); a card with no accounts is a chosen state the
        // pill shows. What remains is a card whose accounts are not signed in.
        personaNotice: computed<string | undefined>(() => {
            const pinned = conversation().selection.actsAs.value;
            // A built-in is always there and names its own reach in the menu; nothing to interrupt the composer for.
            if (builtInOf(pinned) !== undefined) {
                return undefined;
            }
            if (pickedPersona.value === undefined) {
                return t(`chat.panePersona.personaGone`, { name: pinned });
            }
            return pickedPersona.value.capabilities.length === 0 || pickedPersona.value.capabilities.some((held) => personaSignedIn(held))
                ? undefined
                : t(`chat.panePersona.personaNotSignedIn`, { name: personaName.value });
        }),
    };
};
