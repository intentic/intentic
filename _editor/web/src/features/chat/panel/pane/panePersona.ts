import { personaModels } from "@intentic/sandbox-contract";
import { computed, type Ref, watch } from "vue";
import { usePersonas } from "../../../sandbox/personas/usePersonas";
import { roleSources } from "../../accounts/roleModel";
import type { ChatRouting } from "../../routing/chatRoute";
import type { Conversation } from "../../session/conversation";

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
    const personaName = computed(() => pickedPersona.value?.label ?? pickedPersona.value?.id ?? conversation().selection.actsAs.value);

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
        pickPersona,
        // A missing card fails closed daemon-side (no accounts, no tools); a card with no accounts is a chosen state the
        // pill shows. What remains is a card whose accounts are not signed in.
        personaNotice: computed<string | undefined>(() => {
            const pinned = conversation().selection.actsAs.value;
            if (pinned === undefined) {
                return undefined;
            }
            if (pickedPersona.value === undefined) {
                return `This chat acts as "${pinned}", which no longer exists: it would reach no account and no tools. Pick another persona.`;
            }
            return pickedPersona.value.capabilities.length === 0 || pickedPersona.value.capabilities.some((held) => personaSignedIn(held))
                ? undefined
                : `${personaName.value} isn't signed in yet, so this chat can't act as it. Finish its login under Capabilities.`;
        }),
    };
};
