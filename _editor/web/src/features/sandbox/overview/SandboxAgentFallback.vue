<!-- One Agent category before the sandbox's settings have answered, the first time it is opened: its sections under their real headings. -->
<script setup lang="ts">
import { Button, Icon, RowGroup, Section, SkeletonRows } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ShelfSkeleton from "../agent-settings/skills/ShelfSkeleton.vue";
import SectionLink from "../SectionLink.vue";
import { here, page } from "../../../lib/routes/links";

// SandboxAgent's <Await> draws this until a category has been seen once; afterwards its remembered look stands instead.
// Each category promises its first screen: the groups' titles, captions and fixed buttons drawn for real (disabled, as
// nothing can be done before the settings are read), and only what the settings decide as bars. Every row in these
// groups is titled, described and ends in a control.

const { section } = defineProps<{ section: `jobs` | `instructions` | `tools` | `finishing` }>();

const t = useT();

// The jobs a fresh sandbox has on no setup, and the setups' cards: two models and a few jobs each.
const UNASSIGNED_CHIPS = [`w-28`, `w-24`, `w-24`, `w-32`, `w-28`, `w-24`, `w-32`, `w-36`, `w-28`, `w-28`];
const SETUP_JOBS = [`w-32`, `w-28`, `w-36`];
</script>

<template>
    <!-- The category's own column (SandboxAgent's gap-6), so the wait is one region a reader is told about. -->
    <div role="status" aria-busy="true" :aria-label="t(`ui.status.loading`)" class="flex flex-col gap-6">
        <div v-if="section === `jobs`" class="flex flex-col gap-4">
            <Section :label="t(`sandbox.agentModels.notAssigned`)" :heading="2">
                <template #actions>
                    <Button size="small" tier="boring" :label="t(`sandbox.agentModels.placeSuggested`)" disabled>
                        <template #icon><Icon name="sparkles" /></template>
                    </Button>
                </template>
                <p class="mb-2.5 text-2xs text-subtle">{{ t(`sandbox.agentModels.notAssignedCaption`) }}</p>
                <div class="flex min-h-12 flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-line p-3" aria-hidden="true">
                    <span v-for="(width, index) in UNASSIGNED_CHIPS" :key="index" class="skeleton block h-6.5 rounded-full" :class="width" />
                </div>
            </Section>
            <Section :label="t(`sandbox.agentModels.setups`)" :heading="2">
                <template #actions>
                    <Button size="small" tier="boring" :label="t(`sandbox.agentModels.newSetup`)" disabled>
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>
                <p class="mb-2.5 text-2xs text-subtle">{{ t(`sandbox.agentModels.setupsCaption`) }}</p>
                <!-- SetupCard's frame: its name and model picker, its models in order, then the jobs it runs. -->
                <div class="flex flex-col gap-3" aria-hidden="true">
                    <section v-for="card in 2" :key="card" class="flex flex-col gap-3 rounded-xl bg-card p-3 shadow-sm">
                        <header class="flex min-h-7 items-center gap-2">
                            <span class="skeleton block h-3.5" :class="card === 1 ? `w-12` : `w-16`" />
                            <span class="ml-auto skeleton block h-7 w-56 rounded-md" />
                        </header>
                        <span v-for="pin in 2" :key="pin" class="skeleton block h-8.5 w-full rounded-lg" />
                        <div class="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg bg-canvas/60 p-2">
                            <span v-for="(width, index) in SETUP_JOBS" :key="index" class="skeleton block h-6.5 rounded-full" :class="width" />
                        </div>
                    </section>
                </div>
            </Section>
        </div>

        <template v-else-if="section === `instructions`">
            <RowGroup :label="t(`sandbox.words.instructions`)"><SkeletonRows :rows="1" description control /></RowGroup>
            <Section :label="t(`sandbox.agentSkills.skills`)">
                <template #actions>
                    <!-- The filter shows from eight skills, which the built-in ones and a connection or two already make. -->
                    <span class="skeleton block h-8 w-56 max-w-full rounded-md" aria-hidden="true" />
                    <Button size="small" tier="boring" :label="t(`sandbox.words.writeSkill`)" disabled>
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>
                <ShelfSkeleton :shelves="[3, 1, 4, 2]" />
            </Section>
            <Section :label="t(`sandbox.agentMemory.memory`)">
                <template #actions>
                    <Button size="small" tier="quiet" :label="t(`sandbox.agentMemory.import`)" disabled>
                        <template #icon><Icon name="download" /></template>
                    </Button>
                </template>
                <ShelfSkeleton :shelves="[1, 2]" />
            </Section>
        </template>

        <template v-else-if="section === `tools`">
            <RowGroup :label="t(`sandbox.agentChatPages.group`)"><SkeletonRows :rows="1" description control /></RowGroup>
            <RowGroup :label="t(`sandbox.agentVoice.group`)"><SkeletonRows :rows="4" description control /></RowGroup>
            <RowGroup :label="t(`sandbox.agentDocumentSearch.group`)"><SkeletonRows :rows="1" description control /></RowGroup>
            <RowGroup :label="t(`sandbox.agentCodeSearch.codeSearch`)"><SkeletonRows :rows="1" description control /></RowGroup>
            <RowGroup :label="t(`sandbox.agentCommandOutput.commandOutput`)"><SkeletonRows :rows="1" description control /></RowGroup>
        </template>

        <template v-else>
            <RowGroup :label="t(`sandbox.agentChecks.mainCi`)"><SkeletonRows :rows="1" description control /></RowGroup>
            <RowGroup :label="t(`sandbox.agentFinishedWork.finishedWork`)"><SkeletonRows :rows="6" description control /></RowGroup>
            <SectionLink :text="t(`sandbox.sandboxAgent.deletingIsRetention`)" :to="here(page.sandboxSettings(`retention`))" :label="t(`sandbox.sandboxNav.retention`)" />
            <RowGroup :label="t(`sandbox.agentCommitAuthor.group`)"><SkeletonRows :rows="2" description control /></RowGroup>
        </template>
    </div>
</template>
