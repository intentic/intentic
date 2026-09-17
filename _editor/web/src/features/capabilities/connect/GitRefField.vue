<!-- The version an install pins to: resolved from the repository above rather than pasted in, since nobody should have
     to fetch a 40-character commit sha off a web page to install something. -->
<script setup lang="ts">
import type { RemoteRefs } from "@intentic/sandbox-contract";
import type { CapabilityField } from "@intentic/extension-manifest";
import { Picker, ui } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { isCommitSha } from "../model/form";
import { initialChoice, MANUAL_KEY, refFor, refGroups, refKey, refSummary, shortSha } from "../model/refs";
import { readRemoteRefs } from "./useCapabilities";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { field, values, url, token, keeping } = defineProps<{
    field: CapabilityField;
    /** The form's live answers: this row reads and writes its own key, reactivity is the caller's object. */
    values: Record<string, string>;
    /** The repository being installed from, as typed in the field above; the answers here all come from it. */
    url: string;
    /** The credential for a private repository, so the read is authorized the same way the clone will be. Carries the
     * VAULTED marker on an edit, which the daemon resolves against `keeping`. */
    token: string;
    /** The connection being edited, whose stored token a VAULTED marker stands for; absent while adding. */
    keeping?: string | undefined;
    /** The red treatment, when the form has something to refuse about the stored value. */
    alarm?: string | undefined;
}>();

const emit = defineEmits<{ left: [] }>();

// Long enough that typing a URL is one read rather than one per keystroke, short enough to feel like the field
// answering itself.
const SETTLE_MS = 500;

const refs = ref<RemoteRefs>();
const reading = ref(false);
const failure = ref<string>();
// True once the reader asked for the raw box, or once there was nothing to pick from; the picker never overrules it.
const manual = ref(false);
const chosen = ref<string>();

const target = computed(() => url.trim());
const readable = computed(() => /^https?:\/\/\S+$/i.test(target.value));
// Identifies one read. Both halves matter: adding a token to a repository that refused is a different question.
const question = computed(() => `${target.value}\n${token.trim()}`);
const host = computed(() => URL.parse(target.value)?.host ?? target.value);

const selected = computed(() => (refs.value === undefined || chosen.value === undefined ? undefined : refFor(refs.value, chosen.value)));
const groups = computed(() => (refs.value === undefined ? [] : refGroups(refs.value)));

const choose = (key: string | undefined): void => {
    if (key === MANUAL_KEY) {
        manual.value = true;
        return;
    }
    chosen.value = key;
    const picked = refs.value === undefined || key === undefined ? undefined : refFor(refs.value, key);
    if (picked !== undefined) {
        values[field.key] = picked.sha;
        emit(`left`);
    }
};

// The answer to the question asked last wins: a slow read of an abandoned URL must not overwrite a fast one.
let asked = ``;

const read = async (): Promise<void> => {
    const asking = question.value;
    asked = asking;
    reading.value = true;
    failure.value = undefined;
    try {
        const answer = await readRemoteRefs(target.value, token.trim() === `` ? undefined : token.trim(), keeping);
        if (asked !== asking) {
            return;
        }
        refs.value = answer;
        const choice = initialChoice(answer, values[field.key]);
        manual.value = choice === undefined || choice.kind === `manual`;
        choose(choice?.kind === `ref` ? refKey(choice.ref) : undefined);
    } catch (error) {
        if (asked !== asking) {
            return;
        }
        refs.value = undefined;
        // A repository that cannot be read is not a dead end: the raw box is still there, and so is the reason.
        manual.value = true;
        failure.value = errorMessage(error, `Could not read that repository.`);
    } finally {
        if (asked === asking) {
            reading.value = false;
        }
    }
};

let settling: ReturnType<typeof setTimeout> | undefined;
watch(
    question,
    () => {
        clearTimeout(settling);
        if (!readable.value) {
            refs.value = undefined;
            failure.value = undefined;
            return;
        }
        settling = setTimeout(() => void read(), SETTLE_MS);
    },
    { immediate: true },
);
onBeforeUnmount(() => clearTimeout(settling));

// A commit is pinned but no row on the list names it: the picker has nothing selected, so this says what is actually
// stored rather than leaving the reader to guess from an empty control. Only claims the repository names nothing for
// it once the repository has actually been read.
const pinnedOnly = computed(() => selected.value === undefined && isCommitSha(values[field.key]));
const pinnedNote = computed(() =>
    refs.value === undefined
        ? `Pinned at ${shortSha(values[field.key] ?? ``)}.`
        : `Pinned at ${shortSha(values[field.key] ?? ``)}, a commit this repository names no branch or release for.`,
);
// Offered only once there is a list to go back to; on a repository that never resolved, the box is all there is.
const pickable = computed(() => manual.value && refs.value !== undefined);
</script>

<template>
    <label class="ui-field">
        <span class="ui-field-label">
            {{ field.label }}
            <Icon v-if="selected && !manual" name="check-circle" class="ml-1 align-middle text-2xs text-success" />
        </span>
        <Picker
            v-if="refs && !manual"
            :model-value="chosen"
            :options="groups"
            :aria-label="field.label"
            :placeholder="t(`capabilities.gitRefField.pickVersion`)"
            class="w-full"
            @update:model-value="choose($event)"
        />
        <input
            v-else
            v-model="values[field.key]"
            type="text"
            spellcheck="false"
            :placeholder="t(`capabilities.gitRefField.full40CharacterCommit`)"
            :class="[ui.input(`font-mono`), alarm ? 'ui-field-error-box' : '']"
            @blur="emit('left')"
        />
        <!-- One severity-ordered line below the control, like every other field on this form. -->
        <span v-if="alarm" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ alarm }}
        </span>
        <span v-else-if="reading" class="flex items-center gap-1 text-2xs text-muted">
            <Icon name="spinner" spin class="text-2xs" />
            {{ t(`capabilities.gitRefField.asking`) }} {{ host }} {{ t(`capabilities.gitRefField.whatOffers`) }}
        </span>
        <span v-else-if="failure" class="flex flex-wrap items-center gap-x-1.5 text-2xs text-warning">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ failure }}
            <button type="button" :class="ui.linkButton(`text-2xs underline`)" @click.prevent="read()">{{ t(`ui.action.tryAgain`) }}</button>
        </span>
        <span v-else-if="selected && !manual" class="flex items-center gap-1 text-2xs text-muted">
            <Icon name="check-circle" class="text-2xs text-success" />
            {{ refSummary(selected) }}
        </span>
        <span v-else-if="pinnedOnly" class="flex flex-wrap items-center gap-x-1.5 text-2xs text-muted">
            {{ pinnedNote }}
            <button v-if="pickable" type="button" :class="ui.linkButton(`text-2xs underline`)" @click.prevent="manual = false">
                {{ t(`capabilities.gitRefField.pickBranchReleaseInstead`) }}
            </button>
        </span>
        <span v-else-if="!readable" class="text-2xs text-subtle">{{ t(`capabilities.gitRefField.addRepositoryAboveVersions`) }}</span>
    </label>
</template>
