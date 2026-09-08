<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import { browserOwnsClick, PersonaFace, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { usePersonas } from "../../sandbox/personas/usePersonas";

// The composer's persona picker: who this chat speaks as to the outside world. "Anyone" is a real row, not the absence
// of one, since an empty persona means opposite things attended vs. unattended. A card whose accounts are all signed
// out is still offered, marked rather than hidden: it's still meaningful, just unable to post yet.

const { picked } = defineProps<{ picked?: string }>();
const emit = defineEmits<{ picked: [persona: string | undefined] }>();

const { personas, isConnected } = usePersonas();

// True once any one of a persona's accounts is connected; only a card that reaches nothing is marked.
const ready = (persona: Persona): boolean => persona.capabilities.some((id) => isConnected(id));

// Shown because a mark can't tell reddit-work from reddit-personal, and that's the reason a persona exists.
const accountsOf = (persona: Persona): string => persona.capabilities.join(` · `);

const empty = computed(() => personas.value.length === 0);

// Closes the menu only on a plain click; a click the browser owns (Ctrl/Cmd, opening a new tab) must leave this menu
// open.
const closeMenu = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        emit(`picked`, picked);
    }
};
</script>

<template>
    <!-- Hairline between rows, so a picked row and a hovered neighbor read as two highlights, not one block. -->
    <div class="flex flex-col gap-0.5 p-1">
        <!-- Not an error: the copy explains what an empty list means and where to fix it. -->
        <template v-if="empty">
            <p class="px-2.5 py-3 text-2xs text-subtle">
                No personas yet, so this chat speaks through every account you've connected. Set one up to send a message as one person: with only
                that person's accounts in reach.
            </p>
            <RouterLink
                to="/sandbox/personas"
                class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="closeMenu"
            >
                <Icon name="plus" class="shrink-0 text-xs text-subtle" />
                <span class="text-sm text-content md:text-xs">Set up a persona</span>
            </RouterLink>
        </template>

        <template v-else>
            <!--
                The tick marks the current pick, including Anyone: with none ticked, an unset persona would read as a
                broken menu.
            -->
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
                <!--
                    Same face as this persona's own page and the chat rail. Drawn at full color even when unable to
                    post yet: the line below already says so in words, and dimming would read as this row being
                    disabled instead of just unready.
                -->
                <PersonaFace :persona :size="28" class="mt-0.5" />
                <span class="flex min-w-0 flex-col">
                    <span class="flex min-w-0 items-baseline gap-1.5">
                        <span class="truncate text-sm text-content md:text-xs">{{ persona.label ?? persona.id }}</span>
                        <StatusBadge v-if="persona.powers !== undefined" variant="neutral" size="xs">{{ personaBounds(persona) }}</StatusBadge>
                    </span>
                    <!--
                        An account-less persona still bounds the turn and still names the speaker; what actually blocks
                        a send is said once by the composer instead (ChatPane's personaNotice).
                    -->
                    <!--
                        The card's own blurb, when set: what a chat is matched on, and what tells "Work" from "Studio"
                        fastest.
                    -->
                    <span v-if="persona.brief !== undefined" class="truncate text-2xs text-subtle">{{ persona.brief }}</span>
                    <span v-if="persona.capabilities.length > 0" class="truncate text-2xs" :class="ready(persona) ? `text-subtle` : `text-muted`">
                        {{ accountsOf(persona) }}<template v-if="!ready(persona)">, not signed in yet</template>
                    </span>
                </span>
                <Icon v-if="persona.id === picked" name="check" class="ml-auto mt-1 shrink-0 text-2xs text-primary-500" aria-hidden="true" />
            </button>

            <!-- Link to the page that owns these cards, placed where a list's "manage" row always is. -->
            <RouterLink
                to="/sandbox/personas"
                class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="closeMenu"
            >
                <Icon name="cog" class="shrink-0 text-xs text-subtle" />
                <span class="text-2xs text-subtle">Manage personas</span>
            </RouterLink>
        </template>
    </div>
</template>
