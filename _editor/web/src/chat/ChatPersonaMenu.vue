<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import { PersonaFace, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { usePersonas } from "../composables/sandbox/usePersonas";

/* THE COMPOSER'S PERSONA PICKER — "who is this chat when it reaches the outside world".
 *
 * WHY THE COMPOSER IS THE RIGHT PLACE. The persona layer was born on the unattended side: an automation that
 * wakes at 3am names a card, and everything about the rule was written for the wake nobody is watching. But a
 * person at a composer has the same question and no way to answer it — "reply to this as Work, not as me" was a
 * sentence you could only write in the prompt and hope, while the automations form two screens away had a
 * dropdown that MEANT it. The bound is per turn in the daemon (turnPersona), so the chat was one control short
 * of a feature it already had.
 *
 * ANYONE IS A REAL ROW, not the absence of a pick. Attended and unattended mean opposite things by an empty
 * persona — a chat with none keeps every connected account, a wake with none reaches nothing — and the one
 * place a reader can be told which of those they are looking at is the row that says it in words.
 *
 * A CARD THAT CANNOT ACT IS STILL OFFERED, marked rather than hidden. A persona whose accounts are all signed
 * out is the ordinary state of a freshly cloned workspace: hiding it would answer "where did Work go" with
 * silence, and picking it is still meaningful — the turn is bounded, it simply cannot post yet. */

const { picked } = defineProps<{ picked?: string }>();
const emit = defineEmits<{ picked: [persona: string | undefined] }>();

const router = useRouter();
const { personas, isConnected } = usePersonas();

// Whether a card can act at all right now. One signed-in account is enough — a persona naming three and
// holding one still reaches that one, so only the card that reaches nothing is marked.
const ready = (persona: Persona): boolean => persona.capabilities.some((id) => isConnected(id));

// The accounts under the name, because a mark cannot tell `reddit-work` from `reddit-personal` and those two
// being different accounts is the entire reason a persona exists.
const accountsOf = (persona: Persona): string => persona.capabilities.join(` · `);

const empty = computed(() => personas.value.length === 0);

const openPersonas = (): void => {
    void router.push(`/sandbox/personas`);
    emit(`picked`, picked);
};
</script>

<template>
    <!-- A hairline between rows so a picked row and the row you are hovering next to it read as two highlights
         rather than one merged block — the same seam the other picker lists keep. -->
    <div class="flex flex-col gap-0.5 p-1">
        <!-- Nothing set up is the ordinary state, not an error, and the sentence's job is to say what that
             MEANS here (this chat can reach everything) and where personas come from. -->
        <template v-if="empty">
            <p class="px-2.5 py-3 text-2xs text-subtle">
                No personas yet, so this chat speaks through every account you've connected. Set one up to send a message as one person — with only
                that person's accounts in reach.
            </p>
            <button type="button" class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3" @click="openPersonas">
                <Icon name="plus" class="shrink-0 text-xs text-subtle" />
                <span class="text-sm text-content md:text-xs">Set up a persona</span>
            </button>
        </template>

        <template v-else>
            <!-- THE TICK IS WHY THIS LIST GREW A THIRD COLUMN. Picked and merely-hovered were painted the same
                 tint, and the pointer is resting on a row the entire time the menu is open — so the one question
                 the list exists to answer ("who is it set to?") was the one it could not answer while you were
                 reading it. Every other picker in the app already ticks its current row; this one now agrees.
                 It also has to be on ANYONE, which is a real choice here rather than the absence of one: a chat
                 with no persona keeps every account, so "nothing ticked" would read as a broken menu. -->
            <button
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': picked === undefined }"
                :aria-selected="picked === undefined"
                @click="emit(`picked`, undefined)"
            >
                <Icon name="users" class="mt-0.5 shrink-0 text-xs text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="text-sm text-content md:text-xs">Anyone</span>
                    <span class="text-2xs text-subtle">Every account you've connected is in reach, and the full toolbox.</span>
                </span>
                <Icon v-if="picked === undefined" name="check" class="ml-auto mt-0.5 shrink-0 text-2xs text-primary-500" aria-hidden="true" />
            </button>

            <button
                v-for="persona in personas"
                :key="persona.id"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': persona.id === picked }"
                :aria-selected="persona.id === picked"
                @click="emit(`picked`, persona.id)"
            >
                <!-- The same face this persona wears on its own page and in the chat rail — assembled from its
                     name, so one persona is one character wherever you meet it. Smaller here, and that is the
                     only thing this row gets to say about it: a picker is a list of rows that happen to name
                     personas, not a place you go to look at them.
                     It is drawn at FULL COLOUR even when the card cannot post yet. That was the one place a
                     dimmed face could still be argued for — you are choosing who to send as — but the line
                     underneath already says "not signed in yet" in words, and a greyed face said it in a way
                     that read as "this row is disabled" about a row that is perfectly pickable. -->
                <PersonaFace :persona :size="28" class="mt-0.5" />
                <span class="flex min-w-0 flex-col">
                    <span class="flex min-w-0 items-baseline gap-1.5">
                        <span class="truncate text-sm text-content md:text-xs">{{ persona.label ?? persona.id }}</span>
                        <StatusBadge v-if="persona.powers !== undefined" variant="neutral" size="xs">{{ personaBounds(persona) }}</StatusBadge>
                    </span>
                    <!-- The accounts, and nothing else. A card holding NONE used to be marked here as unable to
                         post anywhere, which is true and is not the reader's problem at the moment they are
                         picking who to speak as: an account-less persona still bounds the turn and still names
                         the speaker, so it is an ordinary row rather than a broken one. What genuinely blocks a
                         send — a signed-out account, a card that no longer exists — is said by the composer,
                         once, where the send is about to happen (ChatPane's personaNotice). -->
                    <span v-if="persona.capabilities.length > 0" class="truncate text-2xs" :class="ready(persona) ? `text-subtle` : `text-muted`">
                        {{ accountsOf(persona) }}<template v-if="!ready(persona)"> — not signed in yet</template>
                    </span>
                </span>
                <Icon v-if="persona.id === picked" name="check" class="ml-auto mt-1 shrink-0 text-2xs text-primary-500" aria-hidden="true" />
            </button>

            <!-- The way to the page that owns these cards, at the bottom where a list's "manage" always is: a
                 picker is where someone notices a persona is missing an account, and sending them hunting for
                 the sandbox hub from here is how a two-second fix becomes a task for later. -->
            <button type="button" class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3" @click="openPersonas">
                <Icon name="cog" class="shrink-0 text-xs text-subtle" />
                <span class="text-2xs text-subtle">Manage personas</span>
            </button>
        </template>
    </div>
</template>
