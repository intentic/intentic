<script setup lang="ts">
import type { SkillDraft, SkillSummary } from "@intentic-app/api-contract";
import { Icon, Row, RowGroup, SearchBar } from "@intentic/ui";
import { computed, ref } from "vue";
import { useCapabilities } from "../../../composables/extensions/useCapabilities";
import { useExtensions } from "../../../composables/extensions/useExtensions";
import { useSkills } from "../../../composables/sandbox/useSkills";
import SkillForm from "./SkillForm.vue";
import SkillRow from "./SkillRow.vue";
import SkillsInfo from "./SkillsInfo.vue";
import { bySection, isTunable, matchesSkill } from "./skillList";
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
 * Windows PC — and both reads are cached app-wide and warmed by the rail, so the marks cost this tab nothing.
 *
 * AND WHY MOST OF IT IS FOLDED. Completeness is still the promise, but it stopped being free the moment every
 * connected account began shipping a cheatsheet: at forty-one rows the twelve a reader can actually tune are
 * lost among them, and the three sibling groups under this one — Rules, Memory, what the agent is told — are off
 * the bottom of a page nobody scrolls to the end of. So the rows that came with something else collapse behind
 * one line that states how many they are (skillList draws that line; see it for why it falls where it does).
 * Nothing is hidden: the fold opens on a click and on any search, and its count is on the summary, which is what
 * keeps "what is my agent carrying" answerable without the list being as long as the connection list.
 *
 * THE FILTER ARRIVES WHEN IT IS EARNED and reads more than the name — the trigger line and the provenance chip
 * too, so "connection" or "producthunt" finds the rows the fold is holding. Under a handful of skills it would
 * be more chrome than the thing it filters, so there isn't one. */

const FILTERABLE_FROM = 8;
// Below this many borrowed rows the fold saves nothing worth a click.
const FOLD_FROM = 6;

const { skills, settings, error, save, remove, setEnabled, readBody, forgetBody } = useSkills();
const { capabilities } = useCapabilities();
const { enabled: enabledExtensions } = useExtensions();

const query = ref(``);
const filtering = computed(() => query.value.trim() !== ``);
const filterable = computed(() => skills.value.length >= FILTERABLE_FROM);
const matches = computed<SkillSummary[]>(() => {
    const needle = query.value.trim().toLowerCase();
    return skills.value.filter((skill) => matchesSkill(skill, needle)).toSorted(bySection);
});

// The two halves of the list: what this surface can act on, and what merely arrived with something.
const tunable = computed(() => matches.value.filter(isTunable));
const borrowed = computed(() => matches.value.filter((skill) => !isTunable(skill)));

/* The fold, on the Secrets tab's rule: open while small, open while anything is being looked for, and otherwise
 * shut — except for a reader who opened it by hand, whose answer is remembered so that clearing a search does
 * not fold it back over them. Only recorded when it IS their answer: a fold opened by a search is not a
 * preference. */
const openedByHand = ref<boolean | undefined>(undefined);
const borrowedOpen = computed(() => filtering.value || (openedByHand.value ?? borrowed.value.length <= FOLD_FROM));
const rememberFold = (event: Event): void => {
    if (!filtering.value) {
        openedByHand.value = (event.target as HTMLDetailsElement).open;
    }
};

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

// What the heading counts is what the group is currently showing — a header still claiming 41 over a filtered
// list of three is a header nobody trusts again.
const count = computed<number | undefined>(() => (filtering.value ? matches.value.length : skills.value.length || undefined));
</script>

<template>
    <RowGroup label="Skills" :count="count">
        <template #info><SkillsInfo /></template>
        <!-- The group's own instrument, on the group's own header — it narrows these rows and nothing else on
             the page. A field rather than a bar: there is one control, and a whole toolbar over one group would
             read as belonging to the four groups this one sits among. -->
        <template v-if="filterable" #actions>
            <SearchBar
                v-model="query"
                variant="field"
                clearable
                placeholder="Name, trigger or origin…"
                aria-label="Filter skills"
                autocapitalize="off"
                spellcheck="false"
                class="w-full max-w-64 sm:w-64"
            />
        </template>

        <SkillRow
            v-for="skill in tunable"
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
        <!-- Three different facts, and the wrong one is a lie the reader can see: an empty list, a filter that
             found nothing, and a filter whose only hits are inside the fold below (which is open, so this is
             not it). -->
        <Row v-else-if="matches.length === 0" icon="search" density="compact" description="Nothing matches that filter." />

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

        <!-- EVERYTHING THAT CAME WITH SOMETHING ELSE, behind one line. Last in the group because it is the half
             nobody came here to change — and a row inside the same surface rather than a section of its own, so
             the list still reads as one list with a quiet end to it. -->
        <details v-if="borrowed.length > 0" class="group/fold" :open="borrowedOpen" @toggle="rememberFold">
            <summary
                class="flex cursor-pointer list-none items-center gap-2.5 py-2.5 pl-2.5 pr-3 transition-colors hover:bg-content/4 [&::-webkit-details-marker]:hidden"
            >
                <Icon name="chevron-right" aria-hidden="true" class="shrink-0 text-2xs text-subtle transition-transform group-open/fold:rotate-90" />
                <span class="text-sm text-muted">{{ borrowed.length }} came with what you installed and connected</span>
                <!-- Why they are down here and carry no switch — said where the question is asked, rather than
                     leaving the group's (i) as the only place to learn it. Dropped on a phone rather than
                     wrapped: it explains the line above it, and a two-line summary reads as two facts. -->
                <span class="hidden min-w-0 truncate text-2xs text-subtle sm:inline">to drop one, drop the thing that ships it</span>
            </summary>
            <div class="divide-y divide-line border-t border-line">
                <SkillRow
                    v-for="skill in borrowed"
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
            </div>
        </details>
    </RowGroup>
</template>
