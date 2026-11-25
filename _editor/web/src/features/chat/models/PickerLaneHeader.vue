<script setup lang="ts">
import { SectionHeader } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { termsOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { pickerSource } from "../../../models/conversations/accounts/pickerSource";
import { accessStateFor } from "../../../models/providers/access";
import { modelsPath } from "../../../lib/routes/modelsPath";
import ComputerLaneAction from "./computer/ComputerLaneAction.vue";

// A LANE'S HEADER IN THE MODEL PICKER (ModelPicker.vue): its name, and while it cannot run, the access line, its chip
// (what it costs, what it still needs, that it is not the reader's) with the press that unlocks it at the end: Connect,
// to Sandbox ▸ Models, for a sandbox's provider; Set up or Sign in, run in place, for a coding agent of this computer
// (ComputerLaneAction.vue). Absent once it can run, since a usable provider needs no annotation.

const t = useT();

const {
    provider,
    badge,
    withheld = false,
    promoteFree = false,
} = defineProps<{
    label: string;
    // The lane's single provider; absent for the folded lane of local models, which has no single account.
    provider: AgentProvider | undefined;
    badge: string | undefined;
    // The trial's remaining allowance: a count, not a price, and no press beside it.
    trial: string | undefined;
    // Not the reader's to run (Access ▸ People): the chip says so, and no press unlocks it.
    withheld?: boolean;
    // Only a reader with nothing connected has the free sign-in's chip lit.
    promoteFree?: boolean;
}>();
const emit = defineEmits<{ navigate: [event: MouseEvent] }>();

// Whose lane it is: a sandbox's provider, or a coding agent of this computer (pickerSource.ts).
const computer = computed(() => pickerSource.value.kind === `computer`);

// A provider whose connected account can no longer be refreshed; badged so a broken credential isn't mistaken for a
// healthy one.
const needsReauth = (target: AgentProvider): boolean => accessStateFor(target).needsReauth;

// The vendor's note on a provider whose own loop its terms forbid (the owner keeps such routes by choice); only that
// status earns the list header, since a merely unlisted loop is a choice made later, in the footer.
const forbiddenNote = (target: AgentProvider): string | undefined => {
    // A vendor's terms bind a sandbox running its loop; on this computer it is the reader's own program, run as theirs.
    const terms = computer.value ? undefined : termsOf(target, `native`);
    return terms?.status === `against-terms` ? terms.note : undefined;
};

const lit = (target: AgentProvider): boolean => promoteFree && accessStateFor(target).access?.kind === `free`;
</script>

<template>
    <SectionHeader :label="label" density="dense" class="px-3 pb-1 pt-2" role="presentation">
        <template #info>
            <template v-if="provider !== undefined">
                <Icon v-if="needsReauth(provider)" name="exclamation-triangle" class="text-2xs text-warning" v-tooltip.top="t(`chat.words.reconnectNeeded`)" />
                <!-- A provider whose own loop its vendor forbids, said quietly: the full note sits in the picker footer once picked. -->
                <Icon v-if="forbiddenNote(provider) !== undefined" name="exclamation-circle" class="text-2xs text-subtle" v-tooltip.top="forbiddenNote(provider)" />
                <span
                    v-if="badge !== undefined"
                    class="rounded px-1 py-px text-[0.6rem] font-medium"
                    :class="lit(provider) ? `bg-primary-500/15 text-accent` : `bg-content/5 text-subtle`"
                    >{{ badge }}</span
                >
            </template>
            <!-- The trial's count; no Connect beside it, since this provider already works. -->
            <span v-if="trial !== undefined" class="rounded bg-primary-500/15 px-1 py-px text-[0.6rem] font-medium text-accent">{{ trial }}</span>
        </template>
        <template v-if="provider !== undefined && badge !== undefined && !withheld" #actions>
            <ComputerLaneAction v-if="computer" :provider="provider" />
            <!-- Sandbox ▸ Models, opened on this provider's lane with its sign-in already starting. A real link, so hover shows
                 the destination and Ctrl/Cmd-click opens it in another tab. -->
            <RouterLink v-else :to="modelsPath({ provider })" class="text-2xs text-link hover:underline" @click="emit(`navigate`, $event)">
                {{ t(`ui.action.connect`) }}
            </RouterLink>
        </template>
    </SectionHeader>
</template>
