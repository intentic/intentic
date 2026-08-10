<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import { Avatar, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { identityHue } from "../composables/identityHue";
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
    <div class="flex flex-col p-1">
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
            <button
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': picked === undefined }"
                @click="emit(`picked`, undefined)"
            >
                <Icon name="users" class="mt-0.5 shrink-0 text-xs text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="text-sm text-content md:text-xs">Anyone</span>
                    <span class="text-2xs text-subtle">Every account you've connected is in reach, and the full toolbox.</span>
                </span>
            </button>

            <button
                v-for="persona in personas"
                :key="persona.id"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': persona.id === picked }"
                @click="emit(`picked`, persona.id)"
            >
                <!-- The same mark and the same colour this persona wears on its own page, keyed by id so a
                     rename doesn't recolour somebody you have learned to recognise. -->
                <Avatar :size="20" :name="persona.label ?? persona.id" :hue="identityHue(persona.id)" :idle="!ready(persona)" class="mt-0.5" />
                <span class="flex min-w-0 flex-col">
                    <span class="flex min-w-0 items-baseline gap-1.5">
                        <span class="truncate text-sm text-content md:text-xs">{{ persona.label ?? persona.id }}</span>
                        <StatusBadge v-if="persona.powers !== undefined" variant="neutral" size="xs">{{ personaBounds(persona) }}</StatusBadge>
                        <StatusBadge v-if="persona.posture === `draft`" variant="info" size="xs">Drafts only</StatusBadge>
                    </span>
                    <span v-if="persona.capabilities.length === 0" class="text-2xs text-warning">No accounts — this persona can't post anywhere</span>
                    <span v-else-if="!ready(persona)" class="truncate text-2xs text-warning">{{ accountsOf(persona) }} — not signed in yet</span>
                    <span v-else class="truncate text-2xs text-subtle">{{ accountsOf(persona) }}</span>
                </span>
            </button>

            <!-- The way to the page that owns these cards, at the bottom where a list's "manage" always is: a
                 picker is where someone notices a persona is missing an account, and sending them hunting for
                 the sandbox hub from here is how a two-second fix becomes a task for later. -->
            <button
                type="button"
                class="ui-row-select mt-0.5 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="openPersonas"
            >
                <Icon name="cog" class="shrink-0 text-xs text-subtle" />
                <span class="text-2xs text-subtle">Manage personas</span>
            </button>
        </template>
    </div>
</template>
