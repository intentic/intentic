<!-- THE QUESTION BEFORE DECIDING WHAT BECOMES OF SOMEBODY ELSE'S CONVERSATION (models/fleet/presses/foreignPress.ts),
     mounted once for the whole app so every surface that lands, discards or arms auto-land asks it the same way. Whose
     it is leads, as a face: the name is the one fact the reader missed if this press was a mistake. Amber for the two
     that put work into files other people are working in (the branch keeps everything); red for the one that deletes. -->
<script setup lang="ts">
import { Avatar, ConfirmDialog, type IconName } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { answerForeign, type ForeignAsk, foreignAsk, type ForeignPress } from "../../models/fleet/presses/foreignPress";

const t = useT();

// The last question asked, kept while the dialog animates shut so its words don't blank on the way out.
const shown = ref<ForeignAsk | undefined>(foreignAsk.value);
watch(foreignAsk, (ask) => {
    if (ask !== undefined) {
        shown.value = ask;
    }
});

const ICON = { land: `check`, discard: `trash`, autoLand: `download` } satisfies Record<ForeignPress, IconName>;

const kind = computed<ForeignPress>(() => shown.value?.kind ?? `land`);
const owner = computed(() => shown.value?.owner);
const title = computed(() => shown.value?.title ?? t(`agents.agentStatus.untitledAgent`));
// Every sentence takes both: the given name for the question and its button, the full one for who it belongs to.
const names = computed(() => ({ name: owner.value?.short ?? ``, full: owner.value?.name ?? `` }));
</script>

<template>
    <ConfirmDialog
        :open="foreignAsk !== undefined"
        :header="t(`agents.foreignPress.${kind}.title`, names)"
        :description="t(`agents.foreignPress.${kind}.body`, names)"
        :confirm-label="t(`agents.foreignPress.${kind}.confirm`, names)"
        :confirm-icon="ICON[kind]"
        :destructive="kind === `discard`"
        :tone="kind === `discard` ? undefined : `warning`"
        @cancel="answerForeign(false)"
        @confirm="answerForeign(true)"
    >
        <div v-if="owner !== undefined" class="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-content/5 p-3" data-foreign-press>
            <div class="flex min-w-0 items-center gap-2.5">
                <Avatar :size="32" :name="owner.name" :hue="owner.hue" />
                <div class="flex min-w-0 flex-col">
                    <span class="truncate text-sm font-medium text-content">{{ owner.name }}</span>
                    <span class="truncate text-xs text-muted">
                        {{ owner.email === owner.name ? t(`agents.foreignPress.owner`) : t(`agents.foreignPress.ownerAt`, { email: owner.email }) }}
                    </span>
                </div>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-3 border-t border-line pt-2.5 text-xs">
                <span class="truncate text-content">{{ title }}</span>
                <span v-if="shown?.files !== undefined" class="shrink-0 text-muted">
                    {{ t(`agents.foreignPress.files`, { count: shown.files }, shown.files) }}
                </span>
            </div>
        </div>
    </ConfirmDialog>
</template>
