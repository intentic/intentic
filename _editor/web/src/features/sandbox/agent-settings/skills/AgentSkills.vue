<script setup lang="ts">
import type { SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import { Await, Button, Card, Icon, Modal, Row, SearchBar, Section, SkeletonRows, ui, useDevice } from "@intentic/ui";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { here, page } from "../../../../lib/routes/links";
import { useCapabilities } from "../../../../models/capabilities/useCapabilities";
import { useExtensions } from "../../../../models/extensions/useExtensions";
import { useWorkspaceTabs } from "../../../../models/workspace/tabs/useWorkspaceTabs";
import { sectionReachable } from "../../../../workbench/views/registry";
import { useSkills } from "../../environment/useSkills";
import SkillCard from "./SkillCard.vue";
import SkillChip from "./SkillChip.vue";
import SkillPage from "./SkillPage.vue";
import { NEW_SKILL } from "./skillDrafts";
import { bySection, isWorkspaceSkill, matchesSkill, shelvesOf } from "./skillList";
import type { SkillSources } from "./skillVisual";
import { useT } from "@intentic/ui/i18n";

// Every skill the agent carries, from any source, as a catalog: the reader's own words as cards with room for their
// whole trigger line, then what arrived with connections, extensions and the image as names on labelled shelves, the way
// the Connections catalog groups what brought them. A skill is read and written on its own page, a Workspace tab beside
// the files a skill is made of (SkillPage.vue), never in a drawer squeezed into this column; a phone, whose Workspace
// shows files only, opens that page as a sheet here. Writing a new one opens the page it will become, empty.

const t = useT();

const FILTERABLE_FROM = 8;

const { skills, settings, loaded, setEnabled } = useSkills();
const { capabilities } = useCapabilities();
const { enabled: enabledExtensions } = useExtensions();
const { openSkill } = useWorkspaceTabs();
const { mobile } = useDevice();
const router = useRouter();

const query = ref(``);
const filtering = computed(() => query.value.trim() !== ``);
const filterable = computed(() => skills.value.length >= FILTERABLE_FROM);
const matches = computed<SkillSummary[]>(() => {
    const needle = query.value.trim().toLowerCase();
    return skills.value.filter((skill) => matchesSkill(skill, needle)).toSorted(bySection);
});

// Enabled, not installed: a disabled extension doesn't claim the card its connection came from.
const sources = computed<SkillSources>(() => ({ capabilities: capabilities.value, extensions: enabledExtensions.value }));

const own = computed(() => matches.value.filter(isWorkspaceSkill));
const shelves = computed(() => shelvesOf(matches.value, sources.value));

// The page a phone shows over this list, since its Workspace has no tab to put one in.
const sheet = ref<{ readonly id: string; readonly name: string } | undefined>();

const open = (id: string, name: string): void => {
    if (mobile.value || !sectionReachable(here(page.workspace()))) {
        sheet.value = { id, name };
        return;
    }
    openSkill(id, name);
    void router.push(here(page.workspace()));
};

const startAdd = (): void => open(NEW_SKILL, t(`sandbox.skillForm.newSkill`));
</script>

<template>
    <Await :of="loaded" imprint="sandbox.agent.skills" :label="t(`sandbox.agentSkills.readingSandboxsSkills`)">
        <template #fallback>
            <!-- Until it has been seen once: the section as it reads while loading, its action already where it will be. -->
            <Section :label="t(`sandbox.agentSkills.skills`)">
                <template #actions>
                    <Button size="small" tier="boring" :label="t(`sandbox.words.writeSkill`)" disabled>
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>
                <div role="status" aria-busy="true">
                    <span class="sr-only">{{ t(`sandbox.agentSkills.readingSandboxsSkills`) }}</span>
                    <SkeletonRows :rows="3" description control />
                </div>
            </Section>
        </template>
        <template #failed="{ error }">
            <Section :label="t(`sandbox.agentSkills.skills`)">
                <Card><Row icon="exclamation-triangle" :description="error" /></Card>
            </Section>
        </template>
        <template #default="{ refreshError }">
            <Section data-setting="agent-skills" :label="t(`sandbox.agentSkills.skills`)">
                <template #actions>
                    <!-- One field beside the one action, not a toolbar: a full bar would look like it belongs to more than this section. -->
                    <SearchBar
                        v-if="filterable"
                        v-model="query"
                        variant="field"
                        clearable
                        :placeholder="t(`sandbox.agentSkills.nameTriggerOrigin`)"
                        :aria-label="t(`sandbox.agentSkills.filterSkills`)"
                        autocapitalize="off"
                        spellcheck="false"
                        class="w-56 max-w-full"
                    />
                    <Button size="small" tier="boring" :label="t(`sandbox.words.writeSkill`)" :disabled="settings === undefined" @click="startAdd">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>

                <div class="flex flex-col gap-3">
                    <p v-if="refreshError !== undefined" class="flex items-center gap-1.5 text-xs text-danger">
                        <Icon name="exclamation-triangle" class="text-2xs" aria-hidden="true" />{{ refreshError }}
                    </p>

                    <div v-if="own.length > 0" class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
                        <SkillCard
                            v-for="skill in own"
                            :key="skill.id"
                            :skill="skill"
                            :disabled="settings === undefined"
                            @open="open(skill.id, skill.name)"
                            @enable="(value: boolean) => setEnabled(skill, value)"
                        />
                    </div>
                    <p v-else-if="!filtering" :class="ui.emptyState()">{{ t(`sandbox.agentSkills.noneOfYourOwn`) }}</p>

                    <!-- One surface holding every shelf: a label beside its names, as a properties column reads. -->
                    <Card v-if="shelves.length > 0">
                        <dl class="flex flex-col gap-3">
                            <div v-for="shelf in shelves" :key="shelf.key" class="flex flex-col gap-1.5 @xl:flex-row @xl:gap-3">
                                <dt class="text-xs text-subtle @xl:w-32 @xl:shrink-0 @xl:pt-1.5">{{ shelf.label }}</dt>
                                <dd class="flex min-w-0 flex-wrap gap-1.5">
                                    <SkillChip
                                        v-for="skill in shelf.skills"
                                        :key="skill.id"
                                        :skill="skill"
                                        :sources="sources"
                                        :disabled="settings === undefined"
                                        @open="open(skill.id, skill.name)"
                                        @enable="(value: boolean) => setEnabled(skill, value)"
                                    />
                                </dd>
                            </div>
                        </dl>
                    </Card>

                    <p v-if="filtering && matches.length === 0" class="flex items-center gap-1.5 text-xs text-muted">
                        <Icon name="search" class="text-2xs" aria-hidden="true" />{{ t(`sandbox.agentSkills.nothingMatchesFilter`) }}
                    </p>
                </div>
            </Section>

            <Modal :open="sheet !== undefined" size="full" :header="sheet?.name" @update:open="(value: boolean) => !value && (sheet = undefined)">
                <SkillPage
                    v-if="sheet !== undefined"
                    :key="sheet.id"
                    :skill="sheet.id"
                    :name="sheet.name"
                    host="sheet"
                    @gone="sheet = undefined"
                    @saved="(name: string) => (sheet = { id: name, name })"
                />
            </Modal>
        </template>
    </Await>
</template>
