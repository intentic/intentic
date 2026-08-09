<script setup lang="ts">
import { Avatar, BrandMark, cmp, Notice, type NoticeModel, Segmented } from "@intentic/ui";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import type { BrowserAccount } from "../../composables/extensions/useBrowserAccounts";
import { identityHue } from "../../composables/identityHue";

/* The card editor, used in both places a card is written: opened inside an existing row, and standing alone at
 * the tail of the group for a new one. One component because the two are the same four questions — the only
 * difference is the verb on the button — and a second copy is how the edit form and the add form drift into
 * disagreeing about what a persona has.
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

export interface PersonaDraft {
    original: string | undefined;
    label: string;
    capabilities: string[];
    voice: string;
    posture: `publish` | `draft`;
    /* The shelves, held flat and always fully populated — the draft is a FORM, and a form with tri-state fields
     * is a form with three ways to render every row. The parent folds "everything" back into an absent list on
     * save, which is the shape the card stores (PersonaPowersSchema). */
    files: `none` | `read` | `write`;
    shell: boolean;
    web: boolean;
    browser: boolean;
    delegate: boolean;
    sandbox: boolean;
    /* Per-id grants. `undefined` means every one of them, including any connected tomorrow — which is a real
     * answer and the default, and the reason these are not just arrays. */
    connectors: string[] | undefined;
    computers: string[] | undefined;
    mcp: string[] | undefined;
    startIn: string;
    copy: `` | `own` | `shared`;
    folders: string;
}

/** One connected thing a persona can be granted or denied, in the words the Capabilities page uses. */
export interface PersonaGrantable {
    id: string;
    kind: `cli` | `host` | `mcp`;
    label: string;
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

const POSTURES = [
    { label: `Publishes`, value: `publish` as const },
    { label: `Drafts only`, value: `draft` as const },
];

const FILE_ACCESS = [
    { label: `None`, value: `none` as const },
    { label: `Read`, value: `read` as const },
    { label: `Read & change`, value: `write` as const },
];

const PLACEMENT = [
    { label: `Whatever started it`, value: `` as const },
    { label: `Its own copy`, value: `own` as const },
    { label: `The shared workspace`, value: `shared` as const },
];

/* THE SWITCHES, WITH THE CONSEQUENCE OF TURNING EACH OFF WRITTEN NEXT TO IT. A row that says only "Run
 * commands" makes the reader guess whether tests still run; saying what goes away is the difference between a
 * setting somebody sets and one they leave alone because they cannot predict it. */
const SHELVES = [
    { key: `shell` as const, label: `Run commands`, hint: `Shell, tests, builds, and every CLI on the image.` },
    { key: `web` as const, label: `Read the web`, hint: `Fetch a page, run a search.` },
    { key: `browser` as const, label: `Drive a browser`, hint: `The anonymous browser. Signed-in accounts are the list above.` },
    { key: `delegate` as const, label: `Delegate`, hint: `Spawn sub-agents and run workflows.` },
    { key: `sandbox` as const, label: `Change the sandbox`, hint: `Its own settings and manifests, and the folder that publishes files publicly.` },
];

const GRANT_GROUPS = [
    { key: `connectors` as const, kind: `cli` as const, label: `Connectors`, empty: `No connectors added yet.` },
    { key: `computers` as const, kind: `host` as const, label: `Your computers`, empty: `No computers connected yet.` },
    { key: `mcp` as const, kind: `mcp` as const, label: `MCP connections`, empty: `No MCP connections added yet.` },
];

const groupItems = (kind: PersonaGrantable[`kind`]): PersonaGrantable[] => grantables.filter((entry) => entry.kind === kind);

// `undefined` is "every one of them", so an unset group reads as all-picked — including anything connected
// later, which is what the tri-state buys and what a materialised list of today's ids would silently lose.
const grantsAll = (key: `connectors` | `computers` | `mcp`): boolean => draft[key] === undefined;
const granted = (key: `connectors` | `computers` | `mcp`, id: string): boolean => draft[key]?.includes(id) ?? true;
const toggleGrant = (key: `connectors` | `computers` | `mcp`, id: string, kind: PersonaGrantable[`kind`]): void => {
    // The first click off "all" has to materialise the list before it can remove one from it.
    const current = draft[key] ?? groupItems(kind).map((entry) => entry.id);
    draft[key] = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
};
const setGrantsAll = (key: `connectors` | `computers` | `mcp`, all: boolean): void => {
    draft[key] = all ? undefined : [];
};

/* WHY THE SHELL SWITCH GETS A SENTENCE NOBODY ELSE GETS. A session with a shell can read a credential this card
 * never granted it, so every limit below it is a strong default rather than a wall. Saying that AT the switch is
 * the whole point — a limit that is weaker than it looks is worse than no limit, and the person setting it is
 * the only one who can decide whether that trade is fine for this persona. */
const shellCaveat = computed(() => draft.shell && (draft.connectors !== undefined || draft.computers !== undefined || draft.folders.trim() !== ``));
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
            <!-- Toggles rather than a multi-select: the list is short, picking several is the normal case, and
                 every entry carries a second fact a <select> has nowhere to put — whether it is signed in.
                 The brand mark is what makes a persona reading across two sites visible at a glance. -->
            <div v-else class="flex flex-wrap gap-2">
                <button
                    v-for="account in accounts"
                    :key="account.id"
                    type="button"
                    :aria-pressed="picked(account.id)"
                    :class="[
                        `group flex cursor-pointer items-center gap-2 rounded-lg border py-1.5 pl-2 pr-2.5 text-left transition-colors`,
                        picked(account.id) ? `border-link bg-link/10` : `border-line hover:border-line-strong hover:bg-overlay`,
                    ]"
                    @click="toggleAccount(account.id)"
                >
                    <!-- The brand keeps its colour whether or not it is picked: colour is how you FIND the
                         site you meant in a list of five, and draining it until after the click makes the
                         picker monochrome exactly when it is being scanned. `idle` is kept for its documented
                         meaning — present but switched off — which here is an account not yet signed in. -->
                    <BrandMark :size="20" :name="account.site" :logo="account.logo" :icon="account.icon" :idle="!connected.includes(account.id)" />
                    <!-- ONE LINE, ONE SIZE. The account's name and whatever is left to say about it sit side by
                         side at `text-xs`, told apart by tone rather than by a second, smaller size — which is
                         what a two-row chip needed, and what made the picker the noisiest thing on the page. -->
                    <span class="flex min-w-0 items-baseline gap-1.5 text-xs">
                        <span class="truncate font-medium" :class="picked(account.id) ? `text-content` : `text-muted`">{{ account.id }}</span>
                        <span v-if="detailOf(account) !== undefined" class="truncate text-subtle">{{ detailOf(account) }}</span>
                    </span>
                    <Icon v-if="picked(account.id)" name="check" class="ml-0.5 shrink-0 text-xs text-link" />
                </button>
            </div>
        </div>

        <!-- Optional and long, so it sits below the two that decide what this persona can do, and opens at two
             rows rather than the six-row slab that used to dominate the form. -->
        <label class="ui-field">
            <span class="ui-field-label">Voice <span class="text-xs font-normal text-subtle">· optional</span></span>
            <textarea
                v-model="draft.voice"
                rows="2"
                :class="cmp.input('w-full resize-y')"
                placeholder="How this persona writes, and what it does and doesn't talk about."
            />
        </label>

        <div class="ui-field">
            <span class="ui-field-label">Posture</span>
            <div class="flex flex-wrap items-center gap-2.5">
                <Segmented v-model="draft.posture" :options="POSTURES" />
                <span class="text-xs text-subtle">
                    {{
                        draft.posture === `draft`
                            ? `Prepares posts for you to approve instead of sending them.`
                            : `Posts, replies and sends without asking first.`
                    }}
                </span>
            </div>
        </div>

        <!-- WHAT IT MAY DO. Below the identity questions because that is the order people think in — who is
             this, then what may it touch — and because the account picker above is the one shelf that was here
             before the rest existed. -->
        <div class="flex flex-col gap-3 border-t border-line pt-4">
            <div class="flex flex-col gap-0.5">
                <span class="ui-field-label">What it may do</span>
                <span class="text-xs text-subtle">Everything is on unless you turn it off. A session wearing this card gets exactly what is left.</span>
            </div>

            <div class="flex flex-wrap items-center gap-2.5">
                <span class="w-36 shrink-0 text-sm text-content">Workspace files</span>
                <Segmented v-model="draft.files" :options="FILE_ACCESS" />
            </div>

            <label v-for="shelf in SHELVES" :key="shelf.key" class="flex items-center gap-2.5">
                <span class="w-36 shrink-0 text-sm text-content">{{ shelf.label }}</span>
                <ToggleSwitch v-model="draft[shelf.key]" />
                <span class="min-w-0 text-xs text-subtle">{{ shelf.hint }}</span>
            </label>

            <!-- The one caveat this form owes the reader, and only when it is actually load-bearing: a card
                 that has bounded something WHILE leaving the shell on. Silent otherwise, because a full-powers
                 card has nothing to be misled about. -->
            <p v-if="shellCaveat" :class="cmp.alertWarning('flex items-start gap-2 text-xs')">
                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />
                <span>
                    With <strong>Run commands</strong> on, the limits below it are a strong default rather than a wall — a session with a shell can
                    reach a credential this card didn't grant. Turn it off for a persona that has to be fenced in.
                </span>
            </p>

            <!-- The per-id grants. Collapsed to one line while a group is set to everything, which is the
                 default and the answer most cards keep: a wall of checkboxes for a question nobody asked would
                 bury the switches above that people do come here to set. -->
            <div v-for="group in GRANT_GROUPS" :key="group.key" class="flex flex-col gap-1.5">
                <label class="flex items-center gap-2.5">
                    <span class="w-36 shrink-0 text-sm text-content">{{ group.label }}</span>
                    <ToggleSwitch
                        :model-value="grantsAll(group.key)"
                        :disabled="groupItems(group.kind).length === 0"
                        @update:model-value="setGrantsAll(group.key, $event as boolean)"
                    />
                    <span class="min-w-0 text-xs text-subtle">
                        {{ groupItems(group.kind).length === 0 ? group.empty : grantsAll(group.key) ? `All of them, including new ones.` : `Pick which:` }}
                    </span>
                </label>
                <div v-if="!grantsAll(group.key) && groupItems(group.kind).length > 0" class="flex flex-wrap gap-2 pl-[9.5rem]">
                    <button
                        v-for="item in groupItems(group.kind)"
                        :key="item.id"
                        type="button"
                        :aria-pressed="granted(group.key, item.id)"
                        :class="[
                            `cursor-pointer rounded-lg border px-2.5 py-1 text-xs transition-colors`,
                            granted(group.key, item.id)
                                ? `border-link bg-link/10 font-medium text-content`
                                : `border-line text-muted hover:border-line-strong hover:bg-overlay`,
                        ]"
                        @click="toggleGrant(group.key, item.id, group.kind)"
                    >
                        {{ item.label }}
                    </button>
                </div>
            </div>
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
                    <input v-model="draft.folders" :class="cmp.input('w-full')" placeholder="Anywhere in the workspace" aria-label="Only these folders" />
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
