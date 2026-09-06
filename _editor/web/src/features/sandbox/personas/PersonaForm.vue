<script setup lang="ts">
import type { ModelPin, SystemPromptMode } from "@intentic/sandbox-contract";
import { BrandMark, ui, Notice, type NoticeModel, SearchBar, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, shallowRef } from "vue";
import AddModelButton from "../agent-settings/models/AddModelButton.vue";
import { pinKnobSummary, pinnedList } from "../agent-settings/models/modelPinList";
import ModelPinList from "../agent-settings/models/ModelPinList.vue";
import ModelPinPicker from "../agent-settings/models/ModelPinPicker.vue";
import FolderPicker from "../devices/FolderPicker.vue";
import PersonaKitFields from "./PersonaKitFields.vue";
import PersonaPowersFields from "./PersonaPowersFields.vue";
import type { BrowserAccount } from "../../extensions/useBrowserAccounts";
import type { PersonaGrantable, PersonaPowersDraft } from "./personaCard";
import { useRepos } from "../../workspace/explorer/useRepos";

/* THE CARD EDITOR: a saved persona, opened inside its own row on the Personas page.
 *
 * IT ASKS FIVE QUESTIONS AND SHOWS ONE AT A TIME. Stacked, they ran to roughly thirty controls in one scroll:
 * an account picker, nine permission switches in two columns, two folder pickers, a prompt and a skill list.
 * Every one of them was on screen for someone who came to change a single thing, and the effect was a card that
 * read as a settings dump rather than as a person being described. The answers are exclusive views of one
 * subject, which is what <SegmentedControl> is for, and it is the same control, at the same size, that the Agent tab
 * one level up uses for exactly the same reason.
 *
 * FOUR PILLS FOR FIVE QUESTIONS. "Where it works" stays inside "What it may do" on purpose: a folder fence is a
 * limit on your own tree, the same question as the file dropdown directly above it, and PersonaPowersFields
 * already hosts it in the workspace column for that reason. "Runs on" IS its own pill, because it answers a
 * different kind of question from a fence: not what a session may touch but what its tree HOLDS and which model
 * reads it, the two things that make a card a static context every session on it shares (contract
 * schemas/personas.ts says why that is the design). The brief, the one line a new chat is matched on, sits
 * under the name in "Speaks as", because it is the card saying who it is.
 *
 * AND WHY THE PERMISSIONS ARE NOT SPLIT FURTHER. Their own two columns: "in your workspace" and "reaching out":
 * would make a tidy four-pill strip and would break the one property that block is built around: a reader arrives
 * asking "which of these did I turn off?", and that scan only works while every switch is on one screen. A
 * permission you cannot see is one you cannot audit, so the tabs cut between the card's QUESTIONS and never
 * through the middle of its permissions.
 *
 * A NAME IS NOT ONE OF THE FOUR, because by the time this form exists the card has one: creating a persona asks
 * for a name and nothing else, and the row this opens inside carries it as its title (SandboxPersonas.vue).
 *
 * The draft is the parent's, mutated in place. Deliberate: the parent owns "which card is open" and autosaves
 * the whole card on a debounce, so copying it down and emitting it up would buy encapsulation at the price of
 * the one write path.
 *
 * ONE TYPE SCALE, and only two steps of it that this file chooses. Labels and the things you type into are
 * `text-sm`; everything that comments on them (a hint, an account chip, a fence's caveat) is `text-xs`, and
 * where a chip needs a second tier inside one line it takes it from TONE rather than from a third size. */

// The whole card as a form. The shelves and the per-id grants come from PersonaPowersDraft, because the quick
// panel in the Workspace tree writes those same nine fields and <PersonaPowersFields> renders them for both.
export interface PersonaDraft extends PersonaPowersDraft {
    /** The saved card's id. Always set: a card is created before it is edited. */
    original: string;
    label: string;
    capabilities: string[];
    // Both are lists of workspace-relative folders, and `startIn` holds at most one: the shape <FolderPicker>
    // models either way, so a single-folder question needs no second control and no parsing on the way back.
    startIn: string[];
    folders: string[];
    /* Which system prompt a session wearing this card runs on. `undefined` is the fourth answer and the default:
     * follow the sandbox, which is what almost every card means; the picker's first option writes it.
     *
     * The TEXT is not here, and that is not an oversight: it lives in the card's own kit folder, edited through
     * its own route (usePersonaKit). Carrying it in this draft would put a system prompt inside the debounced
     * whole-card autosave, so every keystroke would rewrite the committed personas file. */
    systemPromptMode: SystemPromptMode | undefined;
    /* WHAT IT IS FOR, in one line (Persona.brief): the sentence a new chat is matched on, and the row's subtitle.
     * "" is a card with none, stored as absent. */
    brief: string;
    /* WHICH NESTED REPOSITORIES ITS CONVERSATIONS CARRY (Persona.context.repos). `undefined` is the default and
     * means every repository the workspace has; a list, even an empty one, is the card deciding, and an empty
     * one is the workspace repository alone. Two states the switch below tells apart on purpose: "everything"
     * has to stay sayable as the absence of a decision, so a card that never opened this tab commits nothing. */
    carries: string[] | undefined;
    /* WHICH MODELS ITS CONVERSATIONS RUN ON, in order (Persona.models). Empty is stored as absent: the chat's
     * own pick, or the job's list, answers instead. */
    models: ModelPin[];
}

const { draft, accounts, connected, grantables, error } = defineProps<{
    draft: PersonaDraft;
    /** The logged-in browser profiles: one per account, so a twice-connected site appears twice. */
    accounts: readonly BrowserAccount[];
    /** Which of those are signed in far enough to act. */
    connected: readonly string[];
    /** The connectors, devices and MCP connections this sandbox has, for the per-id grants. */
    grantables: readonly PersonaGrantable[];
    error?: NoticeModel;
}>();

/* The questions, in the order somebody thinks in: who is this, what may it touch, what does it run on, what is
 * it told. Each label is the heading that part used to carry, so nothing has to be relearned: the card that was
 * one scroll of headings is the same card with those headings turned into a strip. */
const SECTIONS = [
    { label: `Speaks as`, value: `identity` },
    { label: `What it may do`, value: `powers` },
    { label: `Runs on`, value: `runs` },
    { label: `What it is told`, value: `told` },
] as const;
type Section = (typeof SECTIONS)[number][`value`];

/* LOCAL, and reset by the card being closed and reopened rather than remembered. A card is opened to change one
 * thing and the first pill is the one that says who the persona IS: landing on whichever tab was last used on a
 * DIFFERENT persona would open the card on a screen that has nothing to do with why it was opened. */
const section = ref<Section>(`identity`);

/* WHAT A CHIP CAN ADD BEYOND THE ACCOUNT'S OWN NAME, and nothing it already said.
 *
 * A browser capability is usually named after its site, so the site line under the id used to render "reddit"
 * over "Reddit" and "npmjs" over "npmjs.com": the same word twice, on the two commonest chips there are, in the
 * one place a reader is scanning for the DIFFERENCE between two accounts. The site earns a word only when the
 * id does not already carry it: a `main-account` that lives on Reddit, and the brand mark says it in colour
 * either way. `not signed in` is the other half: unlike the site it is never redundant, and it is the fact that
 * decides whether picking this account gets the persona anywhere. */
const compact = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, ``);
const detailOf = (account: BrowserAccount): string | undefined => {
    const id = compact(account.id);
    const saysSite = compact(account.site).startsWith(id) || id.startsWith(compact(account.platform));
    const parts = [...(saysSite ? [] : [account.site]), ...(connected.includes(account.id) ? [] : [`not signed in`])];
    return parts.length === 0 ? undefined : parts.join(` · `);
};

const picked = (id: string): boolean => draft.capabilities.includes(id);
const toggleAccount = (id: string): void => {
    const at = draft.capabilities.indexOf(id);
    if (at === -1) {
        draft.capabilities.push(id);
    } else {
        draft.capabilities.splice(at, 1);
    }
};

/* THE PICKER IS FOLDED AWAY UNTIL SOMEBODY ASKS FOR IT, and that is not tidiness: it is the difference between
 * a form and a wall. A sandbox that has signed into seventeen accounts (an ordinary number here: every identity
 * brings its Reddit, its X, its Product Hunt) rendered seventeen chips in the SECOND field, so the switches and
 * the folder fence below them started a screen further down than the name they belong to.
 *
 * What stays visible is the answer rather than the question: the accounts this card speaks through, as chips that
 * remove themselves when clicked. That is one line for almost every card, nothing at all for a persona that
 * speaks nowhere, and it does not grow with the number of accounts the sandbox happens to hold. */
const open = ref(false);
const filter = ref(``);

// What the card names, in its own order, whether or not this sandbox has that account. An id with no capability
// here is a card describing an account nobody has added yet: dropping it from the summary would quietly rewrite
// what the persona reaches the next time somebody saved the form.
const pickedMarks = computed(() => draft.capabilities.map((id) => ({ id, account: accounts.find((entry) => entry.id === id) })));

// The filter earns its place only once the list is longer than a glance. Matched against the id and the site, so
// "reddit" finds every Reddit account and "spam3" finds the one.
const query = computed(() => filter.value.trim().toLowerCase());
const shown = computed(() =>
    query.value === ``
        ? accounts
        : accounts.filter((account) => account.id.toLowerCase().includes(query.value) || account.site.toLowerCase().includes(query.value)),
);

// The folder fence is this form's field, and one of the bounds a shell can walk around, so the caveat inside
// <PersonaPowersFields> has to know about it.
const folderBound = computed(() => draft.folders.length > 0);

/* ── Runs on ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT ITS TREE HOLDS: one switch for "every repository" (the default, stored as nothing), and under it, when
 * that is off, one per nested repository. Off is a strong statement and the sentence under the list says so: a
 * repository that is off is not fenced, it is ABSENT from the session's checkout. */
const { nested } = useRepos();
const setCarried = (repo: string, on: boolean): void => {
    const current = draft.carries ?? [];
    draft.carries = on ? [...new Set([...current, repo])] : current.filter((name) => name !== repo);
};

/* WHICH MODELS IT RUNS ON, the same editor the role lists on Sandbox ▸ Agent ▸ Models use (modelPinList.ts),
 * over the draft's own list: the ladder is part of the card, so it rides the card's autosave like a switch
 * does. Knobs on, because an entry here says how it runs as well as which model it is. */
const models = pinnedList<ModelPin>({
    read: () => draft.models,
    write: (pins) => {
        draft.models = [...pins];
    },
    decode: (pin) => pin,
    encode: (pin) => pin,
    detail: pinKnobSummary,
    knobs: true,
});
// One picker for the card, over whichever entry raised it; `index` absent means ADDING (AgentModels.vue says why).
const editing = shallowRef<{ index: number | undefined; anchor: HTMLElement } | undefined>(undefined);
const openPicker = (index: number | undefined, anchor: HTMLElement): void => {
    editing.value = { index, anchor };
};
const editingPin = computed<ModelPin | undefined>(() => (editing.value?.index === undefined ? undefined : models.entries.value[editing.value.index]?.pin));
const pick = (pin: ModelPin): void => models.apply(editing.value?.index, pin);
const configure = (pin: ModelPin): void => {
    if (editing.value?.index !== undefined) {
        models.apply(editing.value.index, pin);
    }
};
</script>

<template>
    <!-- AS WIDE AS THE CARD IT OPENED IN. This was capped at a reading measure, which left the right half of an
         opened row empty, and, more to the point, left the powers block no room to put its two groups side by
         side. A settings grid is not prose; the thing that has to stay narrow is the one field you read a line of
         text in, and that field caps itself below. -->
    <div class="flex max-w-4xl flex-col gap-5">
        <!-- Bare pills in the card's own column, with no rule under them: the row this opens inside is already a
             bordered thing, and a second bordered strip immediately inside it reads as two controls at the same
             level when one of them is the card and the other is a part of it. The same call the Agent tab's own
             strip makes one level up. -->
        <SegmentedControl v-model="section" :options="SECTIONS" aria-label="What to change about this persona" />

        <template v-if="section === `identity`">
            <!-- THE ONE LINE THE CARD SAYS ABOUT ITSELF, first, because it is the card saying who it is. It is
                 also the sentence a new chat is matched on (the sandbox's persona router reads one line per card),
                 so the hint asks for the thing that helps that reading: what the work looks like. -->
            <div class="ui-field">
                <label class="ui-field-label" for="persona-brief">What it's for</label>
                <input
                    id="persona-brief"
                    v-model="draft.brief"
                    :class="ui.input('max-w-xl')"
                    maxlength="200"
                    placeholder="Backend work on the api and billing services"
                />
                <span class="text-xs text-subtle">One line. A new chat is matched to a persona by this sentence, so say what its work looks like.</span>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">Speaks through</span>
                <!-- Nothing to offer, said as a fact about this sandbox rather than as something missing from the
                     card: a persona with no accounts is finished, not half-made. -->
                <p v-if="accounts.length === 0" class="text-xs text-subtle">No accounts connected in this sandbox yet.</p>
                <template v-else>
                    <!-- WHAT IT SPEAKS THROUGH, AND THE WAY TO CHANGE IT, on one line. A chip here is a persona's
                         account and clicking it takes that account away, which is why it wears an × rather than the
                         tick the chooser's chips wear: in this row every entry is already picked. -->
                    <div class="flex flex-wrap items-center gap-1.5">
                        <button
                            v-for="mark in pickedMarks"
                            :key="mark.id"
                            type="button"
                            class="ui-chip ui-chip-on group py-1 pl-1.5 pr-2 text-xs hover:border-danger"
                            :aria-label="`Stop speaking through ${mark.id}`"
                            @click="toggleAccount(mark.id)"
                        >
                            <BrandMark
                                :size="16"
                                :name="mark.account?.site ?? mark.id"
                                :logo="mark.account?.logo"
                                :icon="mark.account?.icon ?? `globe`"
                                :idle="!connected.includes(mark.id)"
                            />
                            <span class="truncate font-medium text-content">{{ mark.id }}</span>
                            <Icon name="times" class="shrink-0 text-2xs text-subtle group-hover:text-danger" />
                        </button>
                        <!-- A card that speaks nowhere is a perfectly good card: most personas that work in a
                             folder are one, so the empty row says nothing at all about it. The button beside it is
                             the whole state: nothing picked, and here is where you would pick some. -->
                        <button
                            type="button"
                            :class="ui.linkButton('gap-1 text-xs text-muted hover:text-content')"
                            :aria-expanded="open"
                            @click="open = !open"
                        >
                            <!-- "Add another" and not "Change", because removing one is the chip's own job: the
                                 control that opens the list only ever adds to what is already on the row. -->
                            <Icon :name="open ? `check` : `plus`" class="text-2xs" />
                            {{ open ? `Done choosing` : pickedMarks.length === 0 ? `Choose accounts` : `Add another` }}
                        </button>
                    </div>

                    <!-- THE CHOOSER, only while it is being used. Capped and scrollable rather than as tall as the
                         sandbox is signed into: every account this box holds is pickable, and none of them decides
                         how much room the rest of the form gets. -->
                    <div v-if="open" class="mt-1 flex flex-col gap-2 rounded-lg border border-line bg-overlay/50 p-2">
                        <SearchBar
                            v-if="accounts.length > 6"
                            v-model="filter"
                            variant="field"
                            clearable
                            aria-label="Filter accounts"
                            placeholder="Filter by name or site"
                        />
                        <!-- Toggles rather than a multi-select: picking several is the normal case, and every entry
                             carries a second fact a <select> has nowhere to put, whether it is signed in. The brand
                             mark is what makes a persona reading across two sites visible at a glance. -->
                        <div class="flex max-h-44 flex-wrap gap-2 overflow-y-auto">
                            <button
                                v-for="account in shown"
                                :key="account.id"
                                type="button"
                                :aria-pressed="picked(account.id)"
                                :class="[
                                    `group flex cursor-pointer items-center gap-2 rounded-lg border py-1.5 pl-2 pr-2.5 text-left transition-colors`,
                                    picked(account.id) ? `border-link bg-link/10` : `border-line hover:border-line-strong hover:bg-card`,
                                ]"
                                @click="toggleAccount(account.id)"
                            >
                                <!-- The brand keeps its colour whether or not it is picked: colour is how you FIND
                                     the site you meant in a list of five, and draining it until after the click makes
                                     the picker monochrome exactly when it is being scanned. `idle` is kept for its
                                     documented meaning: present but switched off, which here is an account not yet
                                     signed in. -->
                                <BrandMark
                                    :size="20"
                                    :name="account.site"
                                    :logo="account.logo"
                                    :icon="account.icon"
                                    :idle="!connected.includes(account.id)"
                                />
                                <!-- ONE LINE, ONE SIZE. The account's name and whatever is left to say about it sit
                                     side by side at `text-xs`, told apart by tone rather than by a second, smaller
                                     size, which is what a two-row chip needed, and what made the picker the noisiest
                                     thing on the page. -->
                                <span class="flex min-w-0 items-baseline gap-1.5 text-xs">
                                    <span class="truncate font-medium" :class="picked(account.id) ? `text-content` : `text-muted`">
                                        {{ account.id }}
                                    </span>
                                    <span v-if="detailOf(account) !== undefined" class="truncate text-subtle">{{ detailOf(account) }}</span>
                                </span>
                                <Icon v-if="picked(account.id)" name="check" class="ml-0.5 shrink-0 text-xs text-link" />
                            </button>
                            <span v-if="shown.length === 0" class="px-1 py-1 text-xs text-subtle">No account matches "{{ filter.trim() }}".</span>
                        </div>
                    </div>
                </template>
            </div>
        </template>

        <template v-else-if="section === `powers`">
            <p class="text-xs text-subtle">Everything is on unless you turn it off. A session wearing this card gets exactly what is left.</p>

            <PersonaPowersFields :draft="draft" :grantables="grantables" :folder-bound="folderBound">
                <!-- WHERE IT WORKS RIDES IN THE WORKSPACE COLUMN, because a folder fence is a limit on your own
                     tree: the same question as the two controls above it, and nothing to do with what this card
                     can reach outside. It lives HERE rather than inside the shared block because the quick panel
                     has no pickers. -->
                <template #where="{ rail }">
                    <div class="flex flex-col gap-3">
                        <div class="flex flex-col gap-0.5">
                            <span :class="ui.sectionLabel()">Where it works</span>
                            <!-- STATED, NOT ASKED. This used to be a three-way choice between "whatever started
                                 it", "its own copy" and "the shared workspace": a question whose options a
                                 reader had no way to choose between, on top of a default every surface already
                                 applies. -->
                            <span class="text-xs text-subtle">
                                Every session works in its own copy of the workspace, so several can run at once without touching each other's files.
                            </span>
                        </div>

                        <!-- The label sits ABOVE its picker rather than beside it: a folder field is as wide as
                             the column, and a fixed label column next to it would leave the chips inside no room
                             to be read. The glyph rides the same rail as the switches above: lent by the block
                             itself, so the two cannot fall out of line. -->
                        <div class="flex flex-col gap-1">
                            <span class="flex items-center gap-2 text-sm text-content">
                                <Icon name="folder-open" :class="rail" />
                                Starts in
                            </span>
                            <FolderPicker v-model="draft.startIn" label="Starts in" placeholder="The whole workspace" />
                        </div>

                        <div class="flex flex-col gap-1">
                            <span class="flex items-center gap-2 text-sm text-content">
                                <Icon name="folder" :class="rail" />
                                Only these folders
                            </span>
                            <FolderPicker v-model="draft.folders" multiple label="Only these folders" placeholder="Anywhere in the workspace" />
                            <!-- Said HERE rather than in documentation, because this is the field whose promise is
                                 easiest to over-read: it refuses file tools, and a shell computes its own paths. -->
                            <span class="text-xs text-subtle">
                                File tools pointed outside are refused: this stops mistakes and misread instructions, not a shell.
                            </span>
                        </div>
                    </div>
                </template>
            </PersonaPowersFields>
        </template>

        <template v-else-if="section === `runs`">
            <p class="text-xs text-subtle">
                The tree a session wearing this card opens on, and the model that reads it. Both are the same for every session on this card, which is
                what lets a chat matched to it open on a prompt the provider has already cached.
            </p>

            <div class="ui-field">
                <span class="ui-field-label">Models</span>
                <div class="flex flex-col gap-2">
                    <ModelPinList
                        v-if="models.entries.value.length > 0"
                        :entries="models.entries.value"
                        @promote="models.promote"
                        @remove="models.remove"
                        @edit="(index: number, anchor: HTMLElement) => openPicker(index, anchor)"
                    />
                    <!-- Empty is the ordinary state and says what it means: no ladder here, so the chat's own
                         pick (or the job's list, for a run nobody watched start) answers. -->
                    <p v-else class="text-xs text-subtle">
                        Whatever the chat or the job would have run on anyway. Add a model to decide for every session wearing this card; the
                        first one that answers wins, so a second entry catches an account that is out.
                    </p>
                    <AddModelButton label="Add a model for this persona" @open="(anchor: HTMLElement) => openPicker(undefined, anchor)" />
                </div>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">Carries</span>
                <div class="flex flex-col gap-2">
                    <label class="flex items-center justify-between gap-3">
                        <span class="flex min-w-0 flex-col">
                            <span class="text-sm text-content">Every repository</span>
                            <span class="text-xs text-subtle">The whole workspace, as a chat with no persona sees it.</span>
                        </span>
                        <ToggleSwitch
                            :model-value="draft.carries === undefined"
                            @update:model-value="(on: boolean) => (draft.carries = on ? undefined : [])"
                        />
                    </label>
                    <template v-if="draft.carries !== undefined">
                        <p v-if="nested.length === 0" class="text-xs text-subtle">
                            This workspace has no nested repositories, so the workspace repository is all a session carries either way.
                        </p>
                        <label v-for="repo in nested" :key="repo" class="flex items-center justify-between gap-3 pl-4">
                            <span class="truncate text-sm text-content">{{ repo }}</span>
                            <ToggleSwitch :model-value="draft.carries.includes(repo)" @update:model-value="(on: boolean) => setCarried(repo, on)" />
                        </label>
                        <!-- Said HERE, because this is the switch whose effect is easiest to under-read: it is
                             not a fence on the file tools, the repository is simply not in the checkout. -->
                        <span class="text-xs text-subtle">
                            A repository that is off is not in the session's tree at all: nothing under it exists there. The workspace repository
                            is always carried.
                        </span>
                    </template>
                </div>
            </div>

            <ModelPinPicker
                :open="editing !== undefined"
                :anchor="editing?.anchor"
                :pin="editingPin"
                knobs
                :taken="models.taken.value"
                @update:open="editing = undefined"
                @pick="pick"
                @configure="configure"
            />
        </template>

        <PersonaKitFields
            v-else
            :persona-id="draft.original"
            :mode="draft.systemPromptMode"
            @update:mode="(next: SystemPromptMode | undefined) => (draft.systemPromptMode = next)"
        />

        <Notice v-if="error !== undefined" :of="error" />
    </div>
</template>
