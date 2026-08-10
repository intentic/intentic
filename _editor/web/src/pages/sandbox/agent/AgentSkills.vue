<script setup lang="ts">
import type { SkillDraft, SkillSummary } from "@intentic-app/api-contract";
import { Icon, Row, RowGroup } from "@intentic/ui";
import { computed, ref } from "vue";
import { useCapabilities } from "../../../composables/extensions/useCapabilities";
import { useExtensions } from "../../../composables/extensions/useExtensions";
import { useSkills } from "../../../composables/sandbox/useSkills";
import SkillForm from "./SkillForm.vue";
import SkillRow from "./SkillRow.vue";
import SkillsInfo from "./SkillsInfo.vue";
import type { SkillSources } from "./skillVisual";

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
 * A ROW ONLY OFFERS WHAT IT CAN HONOUR. The switch and the delete render from what the daemon said about that row,
 * never from a rule restated here — a control that appeared to work and was undone by the next reconcile would be
 * worse than no control. What a row shows instead of the missing control is its CHIP: "Plugin · team-pack" names
 * the thing that owns it, and the group's (i) says once what each kind lets you do, rather than every row paying
 * for a sentence that repeats down the list.
 *
 * READING HAPPENS IN PLACE, for any origin, and it is now the row's OWN click — see SkillRow, which is where the
 * hamburger menu that used to guard it went.
 *
 * WHY THIS GROUP READS TWO OTHER LISTS. Almost every row here belongs to something the owner installed or
 * connected, and that thing already has a mark: the extension's manifest, or the card its connection came from.
 * Asking those (skillVisual) is what turns a column of thirteen identical chain links into Discord, GitHub and a
 * Windows PC — and both reads are cached app-wide and warmed by the rail, so the marks cost this tab nothing. */

const { skills, settings, error, save, remove, setEnabled, readBody, forgetBody } = useSkills();
const { capabilities } = useCapabilities();
const { enabled: enabledExtensions } = useExtensions();

// Enabled, not installed: a switched-off extension contributes nothing, so a card claimed by one is not the card
// this connection actually came from — the Capabilities view's own rule about the same join.
const sources = computed<SkillSources>(() => ({ capabilities: capabilities.value, extensions: enabledExtensions.value }));

// Which row is open, by id — one at a time, so the list never becomes a wall of expanded bodies. `adding` is its
// own flag rather than a sentinel id, for the reason the rule list keeps one: a skill may be called anything.
const openId = ref<string | undefined>();
const adding = ref(false);
// The open row's text, once it has arrived. Its own ref rather than a suspense boundary: a body is a fetch of a
// few kilobytes and the row is already on screen, so the honest rendering is the row with a line under it.
const openBody = ref<string | undefined>();
const bodyError = ref<string | undefined>();

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

// Open a row and fetch its text — or close it if it is the one already open. The id is set BEFORE the await so
// the row shows it is opening rather than appearing to ignore the click for a round-trip.
const toggle = async (skill: SkillSummary): Promise<void> => {
    if (openId.value === skill.id) {
        close();
        return;
    }
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

const removeSkill = (skill: SkillSummary): void => {
    remove.mutate(skill.name);
    close();
};
</script>

<template>
    <RowGroup label="Skills" :count="skills.length > 0 ? skills.length : undefined">
        <template #info><SkillsInfo /></template>

        <SkillRow
            v-for="skill in skills"
            :key="skill.id"
            :skill="skill"
            :expanded="openId === skill.id"
            :body="openId === skill.id ? openBody : undefined"
            :body-error="openId === skill.id ? bodyError : undefined"
            :sources="sources"
            :disabled="settings === undefined"
            @toggle="void toggle(skill)"
            @enable="(value: boolean) => setEnabled(skill.name, value)"
            @save="saveDraft"
            @remove="removeSkill(skill)"
        />

        <Row v-if="error !== undefined" icon="exclamation-triangle" density="compact" :description="error" />
        <Row
            v-else-if="skills.length === 0 && !adding"
            icon="book"
            density="compact"
            description="No skills yet. Write one to teach the agent something it should do the same way every time."
        />

        <!-- The new skill is written in the same place a written one is read, so the form is never a different
             screen from the list it joins. -->
        <div v-if="adding" class="bg-content/6">
            <div class="flex items-center gap-2.5 py-2.5 pl-2.5 pr-3">
                <Icon name="plus" class="shrink-0 text-2xs text-subtle" aria-hidden="true" />
                <span class="text-sm font-medium text-content">New skill</span>
            </div>
            <div class="border-t border-line py-3 pl-9 pr-3">
                <SkillForm :disabled="settings === undefined" @save="saveDraft" @cancel="close" />
            </div>
        </div>

        <!-- Hidden while something is open, so there is only ever one skill being written or read at a time. -->
        <Row v-else-if="openId === undefined" as="button" icon="plus" density="compact" interactive title="Write a skill" @click="startAdd" />
    </RowGroup>
</template>
