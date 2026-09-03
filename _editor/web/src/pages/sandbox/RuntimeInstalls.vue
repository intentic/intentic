<script setup lang="ts">
import type { EnvironmentRecurring } from "@intentic-app/api-contract";
import { BrandMark, Code, DisclosureRow, RowGroup, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { startAgent } from "../../composables/agents/agentActions";
import { runtimeInstallVisual } from "./environmentVisual";

/* WHAT SESSIONS KEEP INSTALLING INTO A CONTAINER THAT FORGETS, and — new here — what you can do about it.
 *
 * This list is the daemon's cross-session memory: the install-steering hook records every image-scoped install
 * silently, the drift sweep corroborates it against the live filesystem, and the auto-drafter writes the
 * Dockerfile step for the ecosystems whose step follows from a package name alone. The ones it CANNOT write —
 * a pip package that might belong in a venv, a shell installer whose replay could carry anything — were then
 * "surfaced for a person", and the surface was eleven words and a session count with no action anywhere on it.
 * `chromium-headless-shell` sat on this card for six days: recorded twice, present in the container, agreed on
 * by both channels, and unfixable by any press. A list of problems with no verbs is a list nobody reads twice.
 *
 * SO EVERY ROW ENDS SOMEWHERE. It has a mechanical step → add it, and it joins the proposal above. It does not
 * → hand it to an agent with the tool, the ecosystem and the overlay rules already in the brief, because
 * "which of a venv, apt and pipx" is exactly the judgement a template cannot make and a turn can. Either way →
 * dismiss it, which until now was reachable only as a side effect of rejecting a whole proposal, so a
 * deliberate throwaway install (and anything a classifier bug invented) could not be got rid of at all.
 *
 * AND IT IS DRAWN IN THE TAB'S OWN LANGUAGE rather than in a paragraph of its own devising. The three sections
 * above are a labelled <RowGroup> of <DisclosureRow>s, each with a mark, a name, a mono annotation and its
 * evidence behind a chevron. This was a bold caption over a bare <ul> whose bullets ran `tool · 2 sessions ·
 * proposed` in three greys — a fourth visual language on a tab that had settled on one, sitting directly under
 * the strip that had just taught the reader what a row here looks like. The parallel is exact and it is the
 * point: where a contents row opens onto why a tool is in the image, this one opens onto why it is NOT. */

const { entries, canOperate, busy } = defineProps<{
    entries: readonly EnvironmentRecurring[];
    canOperate: boolean;
    busy: boolean;
}>();

const emit = defineEmits<{ decide: [tool: string, decision: `adopt` | `dismiss` | `restore`] }>();

const open = ref(new Set<string>());
const toggle = (tool: string): void => {
    const next = new Set(open.value);
    if (!next.delete(tool)) {
        next.add(tool);
    }
    open.value = next;
};

/* Answered rows sink. A dismissal is a decision the owner has already made, and leaving those interleaved by
 * recency puts the two entries still asking something underneath four that are not. */
const shown = computed(() =>
    [...entries].toSorted((left, right) => Number(left.declined ?? false) - Number(right.declined ?? false) || right.lastAt - left.lastAt),
);
const countLabel = computed(() => `${shown.value.length} ${shown.value.length === 1 ? `item` : `items`}`);

// Recurrence, in the words the ledger actually counts in: SESSIONS, not commands. A session that retried an
// install five times needed the tool once, and "5 installs" would read as five separate needs.
const sessionsLabel = (entry: EnvironmentRecurring): string => (entry.sessions === 1 ? `1 session` : `${entry.sessions} sessions`);

/* WHAT THE ROW SAYS ABOUT ITS OWN STATE, at most one badge, most actionable first. `live` is deliberately NOT
 * one of them: almost every row here is present right now (that is what corroboration means), so a badge for it
 * would be a tick on every line. It earns a place in the opened row's sentence instead, where it is the reason
 * the rebuild warning is not hypothetical. */
const STATES = {
    drafted: { icon: `sparkles`, label: `proposed`, tone: `text-link` },
    declined: { icon: `eye-slash`, label: `dismissed`, tone: `text-subtle` },
} as const;
const stateOf = (entry: EnvironmentRecurring) => (entry.declined === true ? STATES.declined : entry.drafted === true ? STATES.drafted : undefined);

/* WHY THIS ONE HAS NO BUTTON THAT WRITES THE STEP, said per ecosystem rather than as one shrug. The reason is
 * different in kind each time and it is what the reader needs in order to answer it themselves — or to judge
 * whether the agent's answer was right. */
const NO_STEP: Partial<Record<EnvironmentRecurring[`kind`], string>> = {
    pip: `Where a Python package belongs is a routing decision — a virtualenv, a Debian package, or pipx — and it is a fact about this workspace rather than about the package.`,
    pipx: `pipx installs into a per-tool virtualenv under the home directory, which a rebuild recreates empty; making it durable means deciding what it should become instead.`,
    gem: `A Ruby gem's step depends on which Ruby is meant to own it, and this sandbox does not pin one.`,
    go: `The ledger records the binary's name, not the module path it came from, so there is nothing here to template.`,
    other: `Replaying a shell installer would bake whatever its command line carried, which is not a decision a template gets to make.`,
};
const noStep = (entry: EnvironmentRecurring): string =>
    NO_STEP[entry.kind] ?? `This ecosystem has no Dockerfile step that follows from a package name alone.`;

// What the opened row leads with: the state it is in, in one sentence, because the badges are three words and
// the difference between "proposed" and "dismissed" is what the reader is deciding between.
const explanation = (entry: EnvironmentRecurring): string => {
    if (entry.declined === true) {
        return `Dismissed. Nothing will propose a step for it again, and sessions may go on installing it.`;
    }
    if (entry.drafted === true) {
        return `A step for this is already in the proposal above, waiting for your approval. Approving it bakes the tool into the image on the next rebuild.`;
    }
    const lost = entry.live ? `It is in the container right now and the next rebuild loses it.` : `The container does not have it at the moment.`;
    return entry.step === undefined ? `${lost} ${noStep(entry)}` : `${lost} Its Dockerfile step follows from the package name, so it can be added as it stands.`;
};

/* THE BRIEF THE AGENT GETS, written here rather than left to a chat message the owner has to compose. It
 * carries the three things the turn cannot recover on its own — which tool, which ecosystem, and that the
 * daemon has already watched this repeat — and it names the file to write, so two agents asked the same
 * question converge on one draft instead of appending near-duplicates. It deliberately does NOT assume the
 * answer is an image step: the whole reason this kind has no template is that the tool may belong somewhere
 * else entirely. */
const brief = (entry: EnvironmentRecurring): string =>
    `This sandbox has installed \`${entry.tool}\` (${entry.kind}) at runtime in ${sessionsLabel(entry)}, so it is lost on every container rebuild. ` +
    `Work out where it actually belongs. If it belongs in the sandbox image, load the \`environment\` skill and write the overlay step as ` +
    `\`.intentic/config/environment.d/${entry.tool.replace(/[^a-zA-Z0-9._-]+/g, `-`)}.Dockerfile\` for me to approve. ` +
    `If it belongs to a project instead — a virtualenv, a devDependency, a package script — set it up there and tell me that is what you did.`;
</script>

<template>
    <!-- `flat undivided`, exactly like the three sections above it: this list is already inside the Environment
         card, and a bordered group here would draw a frame around a surface painted in the card's own colour. -->
    <RowGroup
        flat
        undivided
        label="Installed at runtime"
        :count="countLabel"
        caption="Not in the image, so every rebuild loses them."
    >
        <DisclosureRow
            v-for="entry in shown"
            :key="entry.tool"
            :class="entry.declined === true ? `opacity-70` : undefined"
            :open="open.has(entry.tool)"
            @update:open="toggle(entry.tool)"
        >
            <template #lead="{ mark }">
                <BrandMark
                    :size="mark"
                    :name="entry.tool"
                    :logo="runtimeInstallVisual(entry.tool, entry.kind).logo"
                    :icon="runtimeInstallVisual(entry.tool, entry.kind).icon"
                    :idle="entry.declined === true"
                />
            </template>
            <!-- The same line as a contents row, with the same parts in the same order: the name, then the mono
                 annotation that says what the name IS. A package name is a literal, so it takes the mono here
                 that a product name in the sections above does not.

                 THE NAME IS WHAT YIELDS, which is the opposite of the rows above and is right here. There, the
                 name never shrinks because a SENTENCE after it can give up its whole width instead; this row has
                 no sentence, so with both parts `shrink-0` the pair simply overflowed a card sharing its width
                 with the chat column — and the part that ran off the end was the recurrence, which is the fact
                 the row exists to report. `chromium-headless-shell` is also the longest thing on the line and
                 the one a reader can still identify from its first half; `pip · 3 sessions` is neither. -->
            <template #title>
                <span class="flex min-w-0 items-center gap-3 overflow-hidden">
                    <!-- `font-normal`, because mono at the row title's own weight is optically heavier than the
                         sans names in the sections above and made this list — the quieter, unfinished one —
                         the loudest thing on the tab. -->
                    <span v-tooltip.bottom.overflow="entry.tool" class="min-w-0 truncate font-mono font-normal">{{ entry.tool }}</span>
                    <span class="shrink-0 font-mono text-2xs font-normal tabular-nums text-subtle">
                        {{ entry.kind }}<span class="text-muted"> · {{ sessionsLabel(entry) }}</span>
                    </span>
                </span>
            </template>
            <template #meta>
                <span v-if="stateOf(entry) !== undefined" :class="stateOf(entry)?.tone" class="inline-flex items-center gap-1 font-medium">
                    <Icon :name="stateOf(entry)!.icon" />{{ stateOf(entry)!.label }}
                </span>
            </template>
            <template #below>
                <div class="flex flex-col gap-3">
                    <p class="text-xs leading-relaxed text-muted">{{ explanation(entry) }}</p>
                    <!-- The step itself, where there is one, in the same block a contents row uses for what it
                         installs. It is what "Add to the image" would put in front of you, so showing it here is
                         the difference between a button you can judge and one you have to trust — which is also
                         why a DISMISSED row does not show it: nothing is going to add that step, and printing it
                         under "what this would add" makes an answered row look like it is still asking. -->
                    <Code
                        v-if="entry.step !== undefined && entry.declined !== true"
                        :code="entry.step"
                        lang="docker"
                        :label="entry.drafted === true ? `What it adds to the proposal` : `What this would add`"
                        :clamp-lines="10"
                    />
                    <!-- Verbs, and only the ones this row can honour. Quiet by design: the tab spends its one
                         filled shape on the strip's pills, and these sit inside a row the reader has already
                         opened on purpose, so they do not have to shout to be found. -->
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <button
                            v-if="canOperate && entry.step !== undefined && entry.drafted !== true && entry.declined !== true"
                            type="button"
                            :disabled="busy"
                            :class="ui.linkButton(`gap-1 text-2xs font-medium text-link`)"
                            @click="emit(`decide`, entry.tool, `adopt`)"
                        >
                            <Icon name="plus" />Add to the image
                        </button>
                        <button
                            v-if="entry.step === undefined && entry.declined !== true"
                            type="button"
                            :class="ui.linkButton(`gap-1 text-2xs font-medium text-link`)"
                            @click="startAgent(brief(entry))"
                        >
                            <Icon name="sparkles" />Ask an agent where it belongs
                        </button>
                        <button
                            v-if="canOperate"
                            type="button"
                            :disabled="busy"
                            :class="ui.linkButton(`gap-1 text-2xs text-subtle hover:text-content`)"
                            @click="emit(`decide`, entry.tool, entry.declined === true ? `restore` : `dismiss`)"
                        >
                            <Icon :name="entry.declined === true ? `undo` : `eye-slash`" />{{ entry.declined === true ? `Undo` : `Dismiss` }}
                        </button>
                    </div>
                </div>
            </template>
        </DisclosureRow>
    </RowGroup>
</template>
