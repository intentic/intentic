<script setup lang="ts">
import type { SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import { Await, Button, Card, Icon, Modal, Row, SearchBar, Section, SkeletonRows, useDevice } from "@intentic/ui";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { here, page } from "../../../../lib/routes/links";
import { useCapabilities } from "../../../../models/capabilities/useCapabilities";
import { useExtensions } from "../../../../models/extensions/useExtensions";
import { sideDocked } from "../../../../workbench/side/sideTabs";
import { revealSideView } from "../../../../workbench/side/sideViews";
import { useSkills } from "../../environment/useSkills";
import SkillChip from "./SkillChip.vue";
import SkillPage from "./SkillPage.vue";
import { NEW_SKILL } from "./skillDrafts";
import { bySection, matchesSkill, type SkillShelf, shelfLabel, shelvesOf } from "./skillList";
import { SKILL_SIDE_VIEW, skillSideInput } from "./skillSide";
import type { SkillSources } from "./skillVisual";
import { useT } from "@intentic/ui/i18n";

// Every skill the agent carries, from any source, as names on labelled shelves: the reader's own first, then each role's
// kit, then what connections, extensions and the image brought, grouped the way the Connections catalog groups what
// brought them. A press opens the skill's page beside this section (the side panel's skill view, SideSkill.vue), as a
// look the next press replaces, so the reader browses without leaving Settings; a phone, with no side panel, opens it as
// a sheet here. Writing a new one opens the page it will become, empty.

const t = useT();

const FILTERABLE_FROM = 8;

const { skills, settings, loaded, setEnabled } = useSkills();
const { capabilities } = useCapabilities();
const { enabled: enabledExtensions } = useExtensions();
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

// The reader's own shelf stays when it is empty and nothing is filtered: it is where "write one" is said.
const shelves = computed<SkillShelf[]>(() => {
    const found = shelvesOf(matches.value, sources.value);
    return filtering.value || found.some((shelf) => shelf.key === `yours`) ? found : [{ key: `yours`, label: shelfLabel(`yours`), skills: [] }, ...found];
});

// The page a phone shows over this list, since it has no side panel to put one in.
const sheet = ref<{ readonly id: string; readonly name: string } | undefined>();

// A new skill is opened kept: it is being written, and the next press elsewhere must not throw it away.
const open = (id: string, name: string): void => {
    if (sideDocked.value && !mobile.value) {
        revealSideView(SKILL_SIDE_VIEW, skillSideInput(id, name), { keep: id === NEW_SKILL });
        return;
    }
    sheet.value = { id, name };
};

const startAdd = (): void => open(NEW_SKILL, t(`sandbox.skillForm.newSkill`));

// From the phone's sheet, a file of a skill's folder opens where a phone shows files: the Workspace, full screen.
const openFileFromSheet = (path: string): void => {
    void router.push(here(page.workspace(path)));
};
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
                                    <span v-if="shelf.skills.length === 0" class="text-xs text-muted @xl:pt-1.5">{{ t(`sandbox.agentSkills.noneOfYourOwn`) }}</span>
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
                    @open-file="openFileFromSheet"
                />
            </Modal>
        </template>
    </Await>
</template>
