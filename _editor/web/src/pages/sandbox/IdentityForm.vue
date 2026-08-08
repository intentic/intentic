<script setup lang="ts">
import type { CapabilitySummary } from "@intentic-app/api-contract";
import { cmp, Segmented } from "@intentic/ui";
import Button from "primevue/button";

/* The card editor, used in both places a card is written: opened inside an existing row, and standing alone at
 * the tail of the group for a new one. One component because the two are the same four questions — the only
 * difference is the verb on the button — and a second copy is how the edit form and the add form drift into
 * disagreeing about what a face has.
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
    accounts: readonly CapabilitySummary[];
    /** Which of those are signed in far enough to act. */
    connected: readonly string[];
    valid: boolean;
    saving: boolean;
    submitLabel: string;
    error?: string;
    /** Why the name is not usable yet, when it isn't. */
    nameHint?: string;
}>();

const emit = defineEmits<{ submit: []; cancel: [] }>();

const accountLabel = (account: CapabilitySummary): string => {
    const platform = account.config[`platform`];
    return typeof platform === `string` && platform !== account.id ? `${account.id} · ${platform}` : account.id;
};

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
    <div class="flex flex-col gap-3">
        <label class="flex flex-col gap-1">
            <span :class="cmp.sectionLabel('text-2xs')">Name</span>
            <input v-model="draft.label" :class="cmp.input('w-full max-w-sm')" placeholder="Work" />
            <span v-if="nameHint !== undefined" class="text-2xs text-warning">{{ nameHint }}</span>
        </label>

        <div class="flex flex-col gap-1">
            <span :class="cmp.sectionLabel('text-2xs')">Speaks through</span>
            <p v-if="accounts.length === 0" class="text-xs text-subtle">Connect an account first.</p>
            <!-- Toggles rather than a multi-select, because the list is short, every entry has a second fact to
                 carry (whether it is signed in), and picking several is the normal case for a face. -->
            <div v-else class="flex flex-wrap gap-1.5">
                <button
                    v-for="account in accounts"
                    :key="account.id"
                    type="button"
                    :aria-pressed="draft.capabilities.includes(account.id)"
                    :class="[
                        `inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors`,
                        draft.capabilities.includes(account.id)
                            ? `border-link bg-link/10 text-content`
                            : `border-line text-muted hover:border-line-strong hover:text-content`,
                    ]"
                    @click="toggleAccount(account.id)"
                >
                    <Icon :name="draft.capabilities.includes(account.id) ? `check` : `plus`" class="text-2xs" />
                    {{ accountLabel(account) }}
                    <span v-if="!connected.includes(account.id)" class="text-2xs text-subtle">(not signed in)</span>
                </button>
            </div>
        </div>

        <label class="flex flex-col gap-1">
            <span :class="cmp.sectionLabel('text-2xs')">Voice <span class="normal-case">(optional)</span></span>
            <textarea
                v-model="draft.voice"
                rows="3"
                :class="cmp.input('w-full resize-y')"
                placeholder="How this face writes, and what it does and doesn't talk about."
            />
        </label>

        <div class="flex flex-col gap-1">
            <span :class="cmp.sectionLabel('text-2xs')">Posture</span>
            <Segmented v-model="draft.posture" :options="POSTURES" />
            <span class="text-2xs text-subtle">
                {{
                    draft.posture === `draft`
                        ? `Prepares posts for you to approve instead of sending them.`
                        : `Posts, replies and sends without asking first.`
                }}
            </span>
        </div>

        <div v-if="error !== undefined" :class="cmp.alertDanger()">{{ error }}</div>
        <div class="flex items-center gap-2">
            <Button :label="submitLabel" size="small" :loading="saving" :disabled="!valid" @click="emit('submit')" />
            <button type="button" :class="cmp.linkButton('text-muted hover:text-content')" @click="emit('cancel')">Cancel</button>
        </div>
    </div>
</template>
