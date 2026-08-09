<script setup lang="ts">
import { Avatar, BrandMark, cmp, Notice, type NoticeModel, Segmented } from "@intentic/ui";
import Button from "primevue/button";
import { computed } from "vue";
import type { BrowserAccount } from "../../composables/extensions/useBrowserAccounts";
import { identityHue } from "../../composables/identityHue";

/* The card editor, used in both places a card is written: opened inside an existing row, and standing alone at
 * the tail of the group for a new one. One component because the two are the same four questions — the only
 * difference is the verb on the button — and a second copy is how the edit form and the add form drift into
 * disagreeing about what a face has.
 *
 * IT SHOWS YOU WHO YOU ARE MAKING. The avatar at the head is not decoration: it takes the name as it is typed
 * and wears the colour that face will wear in every list it appears in afterwards, so the form reads as
 * building a person rather than filling in four settings about one. Before this the surface was a stack of
 * uppercase labels with nothing at the top to say what the stack was for.
 *
 * The draft is the parent's, mutated in place. Deliberate: the parent owns "which card is open" and has to read
 * the draft back to validate the name against the rest of the cast, so copying it down and emitting it up would
 * buy encapsulation at the price of the one check that keeps two faces from sharing an id. */

export interface IdentityDraft {
    original: string | undefined;
    label: string;
    capabilities: string[];
    voice: string;
    posture: `publish` | `draft`;
}

const { draft, accounts, connected, valid, saving, submitLabel, error, nameHint } = defineProps<{
    draft: IdentityDraft;
    /** The logged-in browser profiles — one per account, so a twice-connected site appears twice. */
    accounts: readonly BrowserAccount[];
    /** Which of those are signed in far enough to act. */
    connected: readonly string[];
    valid: boolean;
    saving: boolean;
    submitLabel: string;
    error?: NoticeModel;
    /** Why the name is not usable yet, when it isn't. */
    nameHint?: string;
}>();

const emit = defineEmits<{ submit: []; cancel: [] }>();

// The face being built, as it will look in the list. An unnamed draft gets the neutral avatar rather than a
// colour it would lose the moment the first letter is typed.
const previewName = computed(() => (draft.label.trim() === `` ? undefined : draft.label.trim()));

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
</script>

<template>
    <!-- One measure for every field. The name input used to be narrower than the textarea under it, which reads
         as two forms stacked rather than one. -->
    <div class="flex max-w-xl flex-col gap-5">
        <!-- Who you are making: the live face, then its name, on one line. -->
        <div class="flex items-center gap-3">
            <Avatar :size="40" :name="previewName" :hue="previewName === undefined ? undefined : identityHue(draft.original ?? previewName)" />
            <div class="ui-field min-w-0 flex-1">
                <input
                    v-model="draft.label"
                    :class="cmp.input('w-full text-base font-medium')"
                    placeholder="Name this face — Work, Personal, Acme…"
                    aria-label="Name"
                />
                <span v-if="nameHint !== undefined" class="text-xs text-warning">{{ nameHint }}</span>
            </div>
        </div>

        <div class="ui-field">
            <span class="ui-field-label">Speaks through</span>
            <p v-if="accounts.length === 0" class="text-xs text-subtle">Connect an account first — a face needs one to speak through.</p>
            <!-- Toggles rather than a multi-select: the list is short, picking several is the normal case, and
                 every entry carries a second fact a <select> has nowhere to put — whether it is signed in.
                 The brand mark is what makes a face reading across two sites visible at a glance. -->
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
                    <BrandMark :size="22" :name="account.site" :logo="account.logo" :icon="account.icon" :idle="!connected.includes(account.id)" />
                    <span class="flex min-w-0 flex-col leading-tight">
                        <span class="truncate text-xs font-medium" :class="picked(account.id) ? `text-content` : `text-muted`">{{ account.id }}</span>
                        <span class="truncate text-2xs text-subtle">
                            {{ account.site }}{{ connected.includes(account.id) ? `` : ` · not signed in` }}
                        </span>
                    </span>
                    <Icon v-if="picked(account.id)" name="check" class="ml-0.5 shrink-0 text-2xs text-link" />
                </button>
            </div>
        </div>

        <!-- Optional and long, so it sits below the two that decide what this face can do, and opens at two
             rows rather than the six-row slab that used to dominate the form. -->
        <label class="ui-field">
            <span class="ui-field-label">Voice <span class="text-xs font-normal text-subtle">· optional</span></span>
            <textarea
                v-model="draft.voice"
                rows="2"
                :class="cmp.input('w-full resize-y text-xs')"
                placeholder="How this face writes, and what it does and doesn't talk about."
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

        <Notice v-if="error !== undefined" :of="error" />
        <div class="flex items-center gap-3">
            <Button :label="submitLabel" size="small" :loading="saving" :disabled="!valid" @click="emit('submit')" />
            <button type="button" :class="cmp.linkButton('text-muted hover:text-content')" @click="emit('cancel')">Cancel</button>
        </div>
    </div>
</template>
