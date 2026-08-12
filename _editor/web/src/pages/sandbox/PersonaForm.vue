<script setup lang="ts">
import { Avatar, BrandMark, cmp, Notice, type NoticeModel, Segmented } from "@intentic/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
import PersonaPowersFields from "./PersonaPowersFields.vue";
import type { BrowserAccount } from "../../composables/extensions/useBrowserAccounts";
import { identityHue } from "../../composables/identityHue";
import type { PersonaGrantable, PersonaPowersDraft } from "../../composables/sandbox/personaCard";

/* The card editor, used in both places a card is written: opened inside an existing row, and standing alone at
 * the tail of the group for a new one. One component because the two are the same three questions — the only
 * difference is the verb on the button — and a second copy is how the edit form and the add form drift into
 * disagreeing about what a persona has.
 *
 * THREE QUESTIONS, AND IT USED TO ASK FIVE. A paragraph on how the persona writes and a publish-or-draft switch
 * sat between the accounts and the switches; both are gone (see PersonaSchema for why the card no longer carries
 * them). What is left is a name, who it speaks as, what it may do and where — which is short enough that someone
 * finishes it, and every field of which changes what a session can actually reach.
 *
 * IT SHOWS YOU WHO YOU ARE MAKING. The avatar at the head is not decoration: it takes the name as it is typed
 * and wears the colour that persona will wear in every list it appears in afterwards, so the form reads as
 * building a person rather than filling in four settings about one. Before this the surface was a stack of
 * uppercase labels with nothing at the top to say what the stack was for.
 *
 * ONE TYPE SCALE, and only two steps of it that this file chooses. Labels and the things you type into are
 * `text-sm`; everything that comments on them — a hint, an account chip, the posture's consequence — is
 * `text-xs`, and where a chip needs a second tier inside one line it takes it from TONE rather than from a
 * third size. The form used to run from `text-base` on the name down to `text-2xs` under an account, which
 * stacked four sizes in 300 pixels and read as four different forms. (<Segmented> keeps its own toolbar-pill
 * size, which is the shared control's decision and the same on every surface that uses one.)
 *
 * The draft is the parent's, mutated in place. Deliberate: the parent owns "which card is open" and has to read
 * the draft back to validate the name against the other personas, so copying it down and emitting it up would
 * buy encapsulation at the price of the one check that keeps two personas from sharing an id. */

// The whole card as a form. The shelves and the per-id grants come from PersonaPowersDraft, because the quick
// panel in the Workspace tree writes those same nine fields and <PersonaPowersFields> renders them for both.
export interface PersonaDraft extends PersonaPowersDraft {
    original: string | undefined;
    label: string;
    capabilities: string[];
    startIn: string;
    copy: `` | `own` | `shared`;
    folders: string;
}

const { draft, accounts, connected, grantables, valid, saving, submitLabel, error, nameHint } = defineProps<{
    draft: PersonaDraft;
    /** The logged-in browser profiles — one per account, so a twice-connected site appears twice. */
    accounts: readonly BrowserAccount[];
    /** Which of those are signed in far enough to act. */
    connected: readonly string[];
    /** The connectors, computers and MCP connections this sandbox has, for the per-id grants. */
    grantables: readonly PersonaGrantable[];
    valid: boolean;
    saving: boolean;
    submitLabel: string;
    error?: NoticeModel;
    /** Why the name is not usable yet, when it isn't. */
    nameHint?: string;
}>();

const emit = defineEmits<{ submit: []; cancel: [] }>();

// The persona being built, as it will look in the list. An unnamed draft gets the neutral avatar rather than a
// colour it would lose the moment the first letter is typed.
const previewName = computed(() => (draft.label.trim() === `` ? undefined : draft.label.trim()));

/* WHAT A CHIP CAN ADD BEYOND THE ACCOUNT'S OWN NAME — and nothing it already said.
 *
 * A browser capability is usually named after its site, so the site line under the id used to render "reddit"
 * over "Reddit" and "npmjs" over "npmjs.com": the same word twice, on the two commonest chips there are, in the
 * one place a reader is scanning for the DIFFERENCE between two accounts. The site earns a word only when the
 * id does not already carry it — a `main-account` that lives on Reddit — and the brand mark says it in colour
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

/* THE PICKER IS FOLDED AWAY UNTIL SOMEBODY ASKS FOR IT, and that is not tidiness — it is the difference between
 * a form and a wall. A sandbox that has signed into seventeen accounts (an ordinary number here: every identity
 * brings its Reddit, its X, its Product Hunt) rendered seventeen chips in the SECOND field, so the switches and
 * the folder fence below them started a screen further down than the name they belong to.
 *
 * What stays visible is the answer rather than the question: the accounts this card speaks through, as chips that
 * remove themselves when clicked. That is one line for almost every card, nothing at all for a persona that
 * speaks nowhere — and it does not grow with the number of accounts the sandbox happens to hold. */
const open = ref(false);
const filter = ref(``);

// What the card names, in its own order, whether or not this sandbox has that account. An id with no capability
// here is a card describing an account nobody has added yet — dropping it from the summary would quietly rewrite
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

const PLACEMENT = [
    { label: `Whatever started it`, value: `` as const },
    { label: `Its own copy`, value: `own` as const },
    { label: `The shared workspace`, value: `shared` as const },
];

// The folder fence is this form's field, and one of the bounds a shell can walk around — so the caveat inside
// <PersonaPowersFields> has to know about it.
const folderBound = computed(() => draft.folders.trim() !== ``);
</script>

<template>
    <!-- One measure for every field. The name input used to be narrower than the textarea under it, which reads
         as two forms stacked rather than one. -->
    <div class="flex max-w-xl flex-col gap-5">
        <!-- Who you are making: the live persona, then its name, on one line. The avatar is the size it will be
             in the list below, so the preview is the row rather than a bigger cousin of it. -->
        <div class="flex items-center gap-3">
            <Avatar :size="32" :name="previewName" :hue="previewName === undefined ? undefined : identityHue(draft.original ?? previewName)" />
            <div class="ui-field min-w-0 flex-1">
                <input
                    v-model="draft.label"
                    :class="cmp.input('w-full font-medium')"
                    placeholder="Name this persona — Work, Personal, Acme…"
                    aria-label="Name"
                />
                <span v-if="nameHint !== undefined" class="text-xs text-warning">{{ nameHint }}</span>
            </div>
        </div>

        <div class="ui-field">
            <span class="ui-field-label">Speaks through</span>
            <p v-if="accounts.length === 0" class="text-xs text-subtle">Connect an account first — a persona needs one to speak through.</p>
            <template v-else>
                <!-- WHAT IT SPEAKS THROUGH, AND THE WAY TO CHANGE IT, on one line. A chip here is a persona's
                     account and clicking it takes that account away, which is why it wears an × rather than the
                     tick the chooser's chips wear: in this row every entry is already picked. -->
                <div class="flex flex-wrap items-center gap-1.5">
                    <button
                        v-for="mark in pickedMarks"
                        :key="mark.id"
                        type="button"
                        class="group flex cursor-pointer items-center gap-1.5 rounded-lg border border-link bg-link/10 py-1 pl-1.5 pr-2 text-xs transition-colors hover:border-danger"
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
                    <!-- A card that speaks nowhere is a perfectly good card — most personas that work in a
                         folder are one — so this states the consequence instead of warning about it. -->
                    <span v-if="pickedMarks.length === 0" class="text-xs text-subtle">Nobody yet — it can work, but not post as anyone.</span>
                    <button
                        type="button"
                        :class="cmp.linkButton('gap-1 text-xs text-muted hover:text-content')"
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
                    <input
                        v-if="accounts.length > 6"
                        v-model="filter"
                        :class="cmp.input('w-full py-1 text-xs')"
                        placeholder="Filter by name or site"
                        aria-label="Filter accounts"
                    />
                    <!-- Toggles rather than a multi-select: picking several is the normal case, and every entry
                         carries a second fact a <select> has nowhere to put — whether it is signed in. The brand
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
                                 documented meaning — present but switched off — which here is an account not yet
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
                                 size — which is what a two-row chip needed, and what made the picker the noisiest
                                 thing on the page. -->
                            <span class="flex min-w-0 items-baseline gap-1.5 text-xs">
                                <span class="truncate font-medium" :class="picked(account.id) ? `text-content` : `text-muted`">
                                    {{ account.id }}
                                </span>
                                <span v-if="detailOf(account) !== undefined" class="truncate text-subtle">{{ detailOf(account) }}</span>
                            </span>
                            <Icon v-if="picked(account.id)" name="check" class="ml-0.5 shrink-0 text-xs text-link" />
                        </button>
                        <span v-if="shown.length === 0" class="px-1 py-1 text-xs text-subtle">No account matches “{{ filter.trim() }}”.</span>
                    </div>
                </div>
            </template>
        </div>

        <!-- WHAT IT MAY DO. Below the identity question because that is the order people think in — who is this,
             then what may it touch — and because the account picker above is the one shelf that was here before
             the rest existed. -->
        <div class="flex flex-col gap-3 border-t border-line pt-4">
            <div class="flex flex-col gap-0.5">
                <span class="ui-field-label">What it may do</span>
                <span class="text-xs text-subtle"
                    >Everything is on unless you turn it off. A session wearing this card gets exactly what is left.</span
                >
            </div>

            <PersonaPowersFields :draft="draft" :grantables="grantables" :folder-bound="folderBound" />
        </div>

        <!-- WHERE IT WORKS. Last, because it is the section most cards leave alone. -->
        <div class="flex flex-col gap-3 border-t border-line pt-4">
            <span class="ui-field-label">Where it works</span>

            <label class="flex items-center gap-2.5">
                <span class="w-36 shrink-0 text-sm text-content">Starts in</span>
                <input v-model="draft.startIn" :class="cmp.input('min-w-0 flex-1')" placeholder="The whole workspace" aria-label="Starts in" />
            </label>

            <div class="flex flex-wrap items-center gap-2.5">
                <span class="w-36 shrink-0 text-sm text-content">Works in</span>
                <Segmented v-model="draft.copy" :options="PLACEMENT" />
            </div>

            <label class="flex items-start gap-2.5">
                <span class="mt-1.5 w-36 shrink-0 text-sm text-content">Only these folders</span>
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                    <input
                        v-model="draft.folders"
                        :class="cmp.input('w-full')"
                        placeholder="Anywhere in the workspace"
                        aria-label="Only these folders"
                    />
                    <!-- Said HERE rather than in documentation, because this is the field whose promise is
                         easiest to over-read: it refuses file tools, and a shell computes its own paths. -->
                    <span class="text-xs text-subtle">
                        Comma-separated. File tools pointed outside are refused — this stops mistakes and misread instructions, not a shell.
                    </span>
                </span>
            </label>
        </div>

        <Notice v-if="error !== undefined" :of="error" />
        <div class="flex items-center gap-3">
            <Button :label="submitLabel" size="small" :loading="saving" :disabled="!valid" @click="emit('submit')" />
            <button type="button" :class="cmp.linkButton('text-muted hover:text-content')" @click="emit('cancel')">Cancel</button>
        </div>
    </div>
</template>
