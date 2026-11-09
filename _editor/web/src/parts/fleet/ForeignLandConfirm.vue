<!-- THE QUESTION BEFORE LANDING SOMEBODY ELSE'S CONVERSATION (models/fleet/presses/foreignLand.ts), mounted once for the
     whole app so every surface that lands by hand asks it the same way. Whose it is leads, as a face: the name is the
     one fact the reader missed if this press was a mistake. Amber, not red: nothing is destroyed (the branch keeps
     everything), but the work goes into files other people are working in. -->
<script setup lang="ts">
import { Avatar, ConfirmDialog } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { answerForeignLand, type ForeignLandAsk, foreignLandAsk } from "../../models/fleet/presses/foreignLand";

const t = useT();

// The last question asked, kept while the dialog animates shut so its words don't blank on the way out.
const shown = ref<ForeignLandAsk | undefined>(foreignLandAsk.value);
watch(foreignLandAsk, (ask) => {
    if (ask !== undefined) {
        shown.value = ask;
    }
});

const owner = computed(() => shown.value?.owner);
const title = computed(() => shown.value?.title ?? t(`agents.agentStatus.untitledAgent`));
</script>

<template>
    <ConfirmDialog
        :open="foreignLandAsk !== undefined"
        :header="t(`agents.foreignLand.title`, { name: owner?.short ?? `` })"
        :description="t(`agents.foreignLand.body`, { name: owner?.name ?? `` })"
        :confirm-label="t(`agents.foreignLand.confirm`, { name: owner?.short ?? `` })"
        confirm-icon="check"
        :destructive="false"
        tone="warning"
        @cancel="answerForeignLand(false)"
        @confirm="answerForeignLand(true)"
    >
        <div v-if="owner !== undefined" class="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-content/5 p-3" data-foreign-land>
            <div class="flex min-w-0 items-center gap-2.5">
                <Avatar :size="32" :name="owner.name" :hue="owner.hue" />
                <div class="flex min-w-0 flex-col">
                    <span class="truncate text-sm font-medium text-content">{{ owner.name }}</span>
                    <span class="truncate text-xs text-muted">
                        {{ owner.email === owner.name ? t(`agents.foreignLand.owner`) : t(`agents.foreignLand.ownerAt`, { email: owner.email }) }}
                    </span>
                </div>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-3 border-t border-line pt-2.5 text-xs">
                <span class="truncate text-content">{{ title }}</span>
                <span v-if="shown?.files !== undefined" class="shrink-0 text-muted">
                    {{ t(`agents.foreignLand.files`, { count: shown.files }, shown.files) }}
                </span>
            </div>
        </div>
    </ConfirmDialog>
</template>
