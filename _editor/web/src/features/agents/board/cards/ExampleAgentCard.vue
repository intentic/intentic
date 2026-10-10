<!-- THE EXAMPLE CARD: what a finished agent looks like, in Finished, on a sandbox whose own first agent has not finished
     yet. Not an agent: no session, no branch, nothing on the daemon, so nothing on the board can select, drag, archive,
     count or land it, and it can only be opened. What it opens is a recorded run, read-only, showing what reviewing and
     landing are before the reader has anything of their own to review. Tagged "Example" wherever it is drawn, so it never
     reads as work someone did here. It goes once the reader's own first agent finishes (AgentsView) or the checklist is
     put away. -->
<script setup lang="ts">
import { Button, Code, DiffStat, Modal, StatusBadge } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import IdentityTile from "../../../capabilities/connect/IdentityTile.vue";
import { startAgent } from "../../fleet/agentActions";
import { EXAMPLE_DIFF, EXAMPLE_FILES } from "./exampleRun";

const t = useT();

const open = ref(false);

const additions = computed(() => EXAMPLE_FILES.reduce((sum, file) => sum + file.additions, 0));
const deletions = computed(() => EXAMPLE_FILES.reduce((sum, file) => sum + file.deletions, 0));

const startOwn = (): void => {
    open.value = false;
    startAgent();
};
</script>

<template>
    <button
        type="button"
        class="session-card flex w-full flex-col gap-2 rounded-2xl border border-dashed p-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
        :aria-label="t(`agents.exampleCard.openLabel`)"
        @click="open = true"
    >
        <span class="flex items-center gap-2.5">
            <IdentityTile :title="t(`agents.exampleCard.title`)" action="new" provider="claude" class="h-7 w-7 text-xs" />
            <span class="min-w-0 flex-1 text-xs font-semibold leading-snug text-content">{{ t(`agents.exampleCard.title`) }}</span>
        </span>
        <!-- The tag leads the facts line rather than the title's, so the title reads whole at a lane's width. -->
        <span class="flex items-center gap-2 text-2xs text-muted">
            <StatusBadge variant="neutral" :label="t(`agents.exampleCard.tag`)" size="xs" />
            <span>{{ t(`agents.exampleCard.files`, { count: EXAMPLE_FILES.length }) }}</span>
            <DiffStat :additions="additions" :deletions="deletions" />
        </span>
        <span class="text-2xs leading-snug text-subtle">{{ t(`agents.exampleCard.line`) }}</span>
    </button>

    <Modal v-model:open="open" size="lg" :header="t(`agents.exampleCard.reviewTitle`)">
        <div class="flex flex-col gap-4">
            <p class="text-xs leading-relaxed text-muted">{{ t(`agents.exampleCard.reviewIntro`) }}</p>

            <!-- 1. What was asked. -->
            <section class="flex flex-col gap-1.5">
                <p class="text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`agents.exampleCard.asked`) }}</p>
                <p class="self-start rounded-2xl bg-overlay px-3 py-2 text-xs text-content">{{ t(`agents.exampleCard.prompt`) }}</p>
            </section>

            <!-- 2. What it did, in its own words, as its last message says. -->
            <section class="flex flex-col gap-1.5">
                <p class="text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`agents.exampleCard.did`) }}</p>
                <p class="text-xs leading-relaxed text-content">{{ t(`agents.exampleCard.reply`) }}</p>
            </section>

            <!-- 3. What changed: the files and the diff, which is what a review is of. -->
            <section class="flex flex-col gap-1.5">
                <p class="text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`agents.exampleCard.changed`) }}</p>
                <ul class="flex flex-col gap-0.5">
                    <li v-for="file in EXAMPLE_FILES" :key="file.path" class="flex items-center gap-2 font-mono text-2xs text-content">
                        <span class="min-w-0 flex-1 truncate">{{ file.path }}</span>
                        <DiffStat :additions="file.additions" :deletions="file.deletions" />
                    </li>
                </ul>
                <Code :code="EXAMPLE_DIFF" lang="diff" :scroll-lines="14" />
            </section>

            <!-- 4. What landing is: the one press this whole board leads to. -->
            <section class="flex flex-col gap-1 rounded-xl bg-success/10 p-3">
                <p class="text-xs font-semibold text-content">{{ t(`agents.exampleCard.landTitle`) }}</p>
                <p class="text-xs leading-relaxed text-muted">{{ t(`agents.exampleCard.landLine`) }}</p>
            </section>
        </div>
        <template #footer>
            <Button tier="quiet" @click="open = false">{{ t(`agents.exampleCard.close`) }}</Button>
            <Button tier="loud" @click="startOwn">{{ t(`agents.exampleCard.startOwn`) }}</Button>
        </template>
    </Modal>
</template>
