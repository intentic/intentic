<script setup lang="ts">
import { Button, Icon, Notice, SectionHeader } from "@intentic/ui";
import { errorMessage } from "@intentic/base/errors";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import { localFace } from "../../app/environments/local";
import type { LocalAgentsHost } from "../../app/environments/localHost";

/* THE ONE SCREEN BEFORE AN AGENT RUNS ON THIS COMPUTER. A sandbox contains its agents: they see its files, not the
   reader's, and their work is reviewed before it lands. None of that holds here, and a warning nobody reads protects
   nobody, so this screen says only what is different and true, once per computer, in the place of the chat it gates.
   The yes is the app's to keep (localHost().agents): the sidecar that runs the turns starts none before it. */

const props = defineProps<{ host: LocalAgentsHost | undefined }>();
const t = useT();

const POINTS = [`runsAsYou`, `reach`, `noUndo`, `asks`] as const;
const failure = ref<string | undefined>();

const turnOn = async (): Promise<void> => {
    failure.value = undefined;
    try {
        await props.host?.accept();
    } catch (error) {
        failure.value = errorMessage(error);
    }
};
</script>

<template>
    <div class="flex h-full min-h-0 items-center justify-center overflow-y-auto p-6">
        <section class="flex w-full max-w-xl flex-col gap-4 rounded-2xl border border-line bg-card p-6" aria-labelledby="local-agents-consent">
            <SectionHeader :label="t(`chat.computer.badge`)" tone="warning">
                <template #mark><Icon name="exclamation-triangle" class="mr-2 text-base text-warning" /></template>
            </SectionHeader>
            <h1 id="local-agents-consent" class="text-lg font-semibold text-content">{{ t(`local.agents.consent.title`) }}</h1>
            <p class="text-xs leading-relaxed text-muted">{{ t(`local.agents.consent.lead`, { folder: localFace()?.name ?? `` }) }}</p>
            <ul class="flex flex-col gap-2 text-xs leading-relaxed text-content">
                <li v-for="point in POINTS" :key="point" class="flex items-baseline gap-2">
                    <Icon name="circle-fill" class="shrink-0 text-[0.4rem] text-warning" />
                    <span>{{ t(`local.agents.consent.${point}`) }}</span>
                </li>
            </ul>
            <p class="text-xs leading-relaxed text-muted">{{ t(`local.agents.consent.sandbox`) }}</p>
            <Notice v-if="failure !== undefined" tone="danger">{{ failure }}</Notice>
            <Notice v-if="host === undefined" tone="info">{{ t(`local.agents.consent.unavailable`) }}</Notice>
            <div v-else class="flex justify-end">
                <Button tier="accent" :label="t(`local.agents.consent.turnOn`)" @click="turnOn" />
            </div>
        </section>
    </div>
</template>
