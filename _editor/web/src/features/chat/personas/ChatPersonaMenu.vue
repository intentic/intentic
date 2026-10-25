<script setup lang="ts">
import { FULL_ACCESS_PERSONA, type Persona } from "@intentic/sandbox-contract/schemas/personas";
import { personaBoundsWords } from "../../../models/sandbox/personas/personaBounds";
import { browserOwnsClick, FACE_SIZES, PersonaFace, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { usePersonas } from "../../../models/sandbox/personas/usePersonas";
import { builtInPersonaViews } from "../../../models/sandbox/personas/builtInPersonas";
import { useRole } from "../../../client/sandbox/useRole";
import { useT } from "@intentic/ui/i18n";

// The composer's persona picker: who this chat speaks as to the outside world. The two built-ins come first and are always
// there: Full access (what no pick means, so picking it sends none) and No accounts. A persona whose accounts are all
// signed out is still offered, marked rather than hidden: it's still meaningful, just unable to post yet.

const t = useT();

const { picked } = defineProps<{ picked?: string }>();
const emit = defineEmits<{ picked: [persona: string | undefined] }>();

const { personas, isConnected } = usePersonas();
// A guest picks among the personas it holds and nothing wider: Full access would reach every account, which is exactly
// what a guest is not handed, No accounts the whole toolbox, and the personas are the owner's to manage.
const { isGuest } = useRole();

// True once any one of a persona's accounts is connected; only a persona that reaches nothing is marked.
const ready = (persona: Persona): boolean => persona.capabilities.some((id) => isConnected(id));

// Shown because a mark can't tell reddit-work from reddit-personal, and that's the reason a persona exists.
const accountsOf = (persona: Persona): string => persona.capabilities.join(` · `);

const empty = computed(() => personas.value.length === 0);

// The built-ins as rows: Full access is what no pick means, so it is ticked for none and picking it sends none.
const builtIns = computed(() =>
    builtInPersonaViews().map((view) => {
        const sends = view.id === FULL_ACCESS_PERSONA ? undefined : view.id;
        return { ...view, sends, on: picked === sends || (sends === undefined && picked === FULL_ACCESS_PERSONA) };
    }),
);

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
        <!-- The tick marks the current pick, built-ins included: with none ticked, an unset persona would read as a broken menu. -->
        <template v-if="!isGuest">
            <button
                v-for="row in builtIns"
                :key="row.id"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3 text-sm md:text-xs"
                :class="{ 'ui-row-select-on': row.on }"
                :aria-selected="row.on"
                @click="emit(`picked`, row.sends)"
            >
                <Icon :name="row.icon" class="shrink-0 text-xs text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="text-sm text-content md:text-xs">{{ row.label }}</span>
                    <span class="text-2xs text-subtle">{{ row.note }}</span>
                </span>
                <Icon v-if="row.on" name="check" class="ml-auto shrink-0 text-2xs text-accent" aria-hidden="true" />
            </button>
        </template>

        <!-- Not an error: the copy explains what an empty list means and where to fix it. -->
        <template v-if="empty">
            <p class="px-2.5 py-3 text-2xs text-subtle">
                {{ isGuest ? t(`chat.chatPersonaMenu.noGuestYet`) : t(`chat.chatPersonaMenu.noPersonasYetChat`) }}
            </p>
            <RouterLink
                v-if="!isGuest"
                to="/sandbox/personas"
                class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="closeMenu"
            >
                <Icon name="plus" class="shrink-0 text-xs text-subtle" />
                <span class="text-sm text-content md:text-xs">{{ t(`chat.words.setUpPersona`) }}</span>
            </RouterLink>
        </template>

        <template v-else>
            <button
                v-for="persona in personas"
                :key="persona.id"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': persona.id === picked }"
                :aria-selected="persona.id === picked"
                @click="emit(`picked`, persona.id)"
            >
                <!-- Same face, at the same size, as this persona's row on its own page; the tighter `py` is what pays for it. -->
                <PersonaFace :persona :size="FACE_SIZES.row" class="mt-0.5" />
                <span class="flex min-w-0 flex-col">
                    <span class="flex min-w-0 items-baseline gap-1.5">
                        <span class="truncate text-sm text-content md:text-xs">{{ persona.label ?? persona.id }}</span>
                        <StatusBadge v-if="persona.powers !== undefined" variant="neutral" size="xs">{{ personaBoundsWords(persona) }}</StatusBadge>
                    </span>
                    <!-- An account-less persona still bounds the turn and still names the speaker. -->
                    <!-- The persona's own blurb, when set: what a chat is matched on, and what tells "Work" from "Studio" fastest. -->
                    <span v-if="persona.brief !== undefined" class="truncate text-2xs text-subtle">{{ persona.brief }}</span>
                    <span v-if="persona.capabilities.length > 0" class="truncate text-2xs" :class="ready(persona) ? `text-subtle` : `text-muted`">
                        {{ accountsOf(persona) }}<template v-if="!ready(persona)">{{ t(`chat.chatPersonaMenu.notSignedInYet`) }}</template>
                    </span>
                </span>
                <Icon v-if="persona.id === picked" name="check" class="ml-auto shrink-0 text-2xs text-accent" aria-hidden="true" />
            </button>

            <!-- Link to the page that owns these personas, placed where a list's "manage" row always is. -->
            <RouterLink
                v-if="!isGuest"
                to="/sandbox/personas"
                class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="closeMenu"
            >
                <Icon name="cog" class="shrink-0 text-xs text-subtle" />
                <span class="text-2xs text-subtle">{{ t(`chat.words.managePersonas`) }}</span>
            </RouterLink>
        </template>
    </div>
</template>
