<script setup lang="ts">
import type { SkillDraft, SkillSummary } from "@intentic-app/api-contract";
import { cmp, ContextMenu, Icon, Row, RowGroup } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useSkills } from "../../../composables/sandbox/useSkills";
import SkillForm from "./SkillForm.vue";
import SkillsInfo from "./SkillsInfo.vue";
import { originOf, provenanceOf } from "./skillWords";

/* WHAT THE AGENT KNOWS — every skill it is carrying right now, where each one came from, and a switch on the ones
 * that are the owner's to switch.
 *
 * WHY THIS IS A LIST AND NOT A CONNECTIONS BOARD. A skill is inert text: it has no credential, nothing to
 * authenticate, and no way to be broken at three in the morning — so it has no business on the surface built for
 * things that connect, where its status light could only ever be green. What it DOES have is a cost. Every skill
 * spends the agent's attention on every turn, which makes pruning them routine tuning rather than configuration
 * you do once. That is the act this group is shaped for: read down it, see what you don't recognise, switch it off.
 *
 * COMPLETENESS IS THE PROMISE. Six things put skills in front of the agent — this image, the owner, every
 * connection, every extension, every plugin, and whatever is simply sitting in the folder — and before this list
 * existed the only way to see the result was to open four directories. So a row appears for every one of them,
 * INCLUDING the loose files nothing claims, and including a built-in that is currently switched off (an offer, not
 * an absence: an unlisted baked tool is one nobody ever learns exists).
 *
 * A ROW ONLY OFFERS WHAT IT CAN HONOUR. The switch and the menu render from what the daemon said about that row,
 * never from a rule restated here — a control that appeared to work and was undone by the next reconcile would be
 * worse than no control. What a row shows instead of the missing control is its CHIP: "Plugin · team-pack" names
 * the thing that owns it, and the group's (i) says once what each kind lets you do, rather than every row paying
 * for a sentence that repeats down the list.
 *
 * READING HAPPENS IN PLACE, for any origin. A skill you did not write is the one you most want to read, because it
 * is the one you cannot remember agreeing to — so expanding a row is the same gesture whether it ends in a form
 * (yours) or in the text as its author shipped it. */

const { skills, settings, error, save, remove, setEnabled, readBody, forgetBody } = useSkills();

// Which row is open, by id — one at a time, so the list never becomes a wall of expanded bodies. `adding` is its
// own flag rather than a sentinel id, for the reason the rule list keeps one: a skill may be called anything.
const openId = ref<string | undefined>();
const adding = ref(false);
// The open row's text, once it has arrived. Its own ref rather than a suspense boundary: a body is a fetch of a
// few kilobytes and the row is already on screen, so the honest rendering is the row with a line under it.
const openBody = ref<string | undefined>();
const bodyError = ref<string | undefined>();

const open = computed<SkillSummary | undefined>(() => skills.value.find((skill) => skill.id === openId.value));
// The form edits a draft, not a row: the row carries provenance the form has no business in, and the body is not
// on the row at all until it has been read.
const editing = computed<SkillDraft | undefined>(() =>
    open.value?.editable === true && openBody.value !== undefined
        ? { name: open.value.name, description: open.value.description, body: openBody.value }
        : undefined,
);

const close = (): void => {
    openId.value = undefined;
    openBody.value = undefined;
    bodyError.value = undefined;
    adding.value = false;
};

const startAdd = (): void => {
    close();
    adding.value = true;
};

// Open a row and fetch its text. The id is set BEFORE the await so the row shows it is opening rather than
// appearing to ignore the click for a round-trip.
const openSkill = async (skill: SkillSummary): Promise<void> => {
    adding.value = false;
    openId.value = skill.id;
    openBody.value = undefined;
    bodyError.value = undefined;
    try {
        openBody.value = (await readBody(skill.id)).body;
    } catch (failure) {
        bodyError.value = failure instanceof Error ? failure.message : `Couldn't read this skill.`;
    }
};

const saveDraft = (draft: SkillDraft): void => {
    // The cached body would otherwise be the version this edit replaced, the next time the row is opened.
    forgetBody(draft.name);
    save.mutate(draft);
    close();
};

// One menu for the list rather than one per row: they differ only in which skill they point at.
const menu = ref<InstanceType<typeof ContextMenu>>();
const menuFor = ref<SkillSummary | undefined>();

const openMenu = (event: Event, skill: SkillSummary): void => {
    menuFor.value = skill;
    menu.value?.show(event);
};

const menuModel = computed<MenuItem[]>(() => {
    const skill = menuFor.value;
    if (skill === undefined) {
        return [];
    }
    return [
        // "Read" and "Edit" are one action on the owner's own skills — the form IS how you read one — so only the
        // label changes. Anything else opens to the text as its author wrote it.
        { label: skill.editable ? `Edit` : `Read`, icon: skill.editable ? `pencil` : `eye`, command: () => void openSkill(skill) },
        ...(skill.removable ? [{ separator: true }, { label: `Delete`, icon: `trash`, danger: true, command: () => remove.mutate(skill.name) }] : []),
    ];
});
</script>

<template>
    <RowGroup label="Skills">
        <template #info><SkillsInfo /></template>

        <template v-for="skill in skills" :key="skill.id">
            <!-- Open in the row's own place, so the list never loses the spot you were looking at. -->
            <Row v-if="openId === skill.id" :icon="originOf(skill.origin).icon" density="compact" :title="skill.name">
                <template #description>{{ provenanceOf(skill) }}</template>
                <template #below>
                    <p v-if="bodyError !== undefined" class="text-2xs text-danger">{{ bodyError }}</p>
                    <p v-else-if="openBody === undefined" class="flex items-center gap-2 text-2xs text-subtle">
                        <Icon name="spinner" class="animate-spin text-xs" />
                        Reading…
                    </p>
                    <SkillForm
                        v-else-if="editing !== undefined"
                        :skill="editing"
                        :disabled="settings === undefined"
                        @save="saveDraft"
                        @cancel="close"
                    />
                    <!-- Someone else's skill, as they wrote it. Monospace and pre-wrapped because it is a file:
                         reflowing it would silently change what the indentation of a code block means. -->
                    <div v-else class="flex flex-col gap-2">
                        <p class="text-2xs text-muted">{{ skill.description }}</p>
                        <!-- Bounded like the form's boxes are, because it is the same kind of object: without the
                             border the text floats on a background a shade off the row's and stops reading as a
                             file you are looking INTO. -->
                        <pre
                            class="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-canvas p-2.5 font-mono text-2xs text-content"
                            >{{ openBody }}</pre
                        >
                        <button type="button" :class="cmp.linkButton(`self-start text-2xs`)" @click="close">Close</button>
                    </div>
                </template>
            </Row>

            <Row v-else :icon="originOf(skill.origin).icon" :title="skill.name" density="compact" :class="{ 'opacity-60': !skill.enabled }">
                <template #description>
                    <span class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span class="shrink-0 rounded bg-overlay px-1.5 py-0.5 text-2xs text-muted">{{ provenanceOf(skill) }}</span>
                        <span v-if="skill.description !== ``" class="min-w-0 max-w-full truncate">{{ skill.description }}</span>
                        <span v-else class="min-w-0 truncate italic">No description — the agent rarely picks a skill without one.</span>
                    </span>
                </template>
                <template #control>
                    <div class="flex items-center gap-1">
                        <button
                            type="button"
                            :class="cmp.iconButton()"
                            v-tooltip.bottom="`Skill actions`"
                            aria-label="Skill actions"
                            @click="openMenu($event, skill)"
                        >
                            <Icon name="bars" class="text-xs" />
                        </button>
                        <ToggleSwitch
                            v-if="skill.switchable"
                            :model-value="skill.enabled"
                            :disabled="settings === undefined"
                            :aria-label="`Enable ${skill.name}`"
                            @update:model-value="(value: boolean) => setEnabled(skill.name, value)"
                        />
                    </div>
                </template>
            </Row>
        </template>

        <Row v-if="error !== undefined" icon="exclamation-triangle" density="compact" :description="error" />
        <Row
            v-else-if="skills.length === 0 && !adding"
            icon="book"
            density="compact"
            description="No skills yet. Write one to teach the agent something it should do the same way every time."
        />

        <Row v-if="adding" icon="plus" density="compact" title="New skill">
            <template #below>
                <SkillForm :disabled="settings === undefined" @save="saveDraft" @cancel="close" />
            </template>
        </Row>

        <!-- Hidden while something is open, so there is only ever one skill being written or read at a time. -->
        <Row v-else-if="openId === undefined" as="button" icon="plus" density="compact" interactive title="Write a skill" @click="startAdd" />
    </RowGroup>

    <ContextMenu ref="menu" :model="menuModel" :min-width="11" />
</template>
