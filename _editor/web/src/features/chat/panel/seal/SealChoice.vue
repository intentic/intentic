<!-- WHO READS THIS CONVERSATION, as the one choice it is: shared with everyone who can see its part of the workspace, or
     private to its author and the people they add. The body of the pill's overlay (SealPill), for a reader's own
     conversation and for a new chat's composer alike; each change is its own save, made by whoever holds it. -->
<script setup lang="ts">
import type { SealPerson } from "@intentic/sandbox-contract/schemas/seal";
import { Avatar, Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { identityHue } from "../../../../lib/identityHue";
import { fullName } from "../../../../models/agent-status/sealView";
import { typedAddress, useSealCandidates } from "../../../../models/conversations/seal/sealPeople";

const t = useT();

const {
    private: closed,
    readers = [],
    people = true,
    busy = false,
    error,
} = defineProps<{
    /** Whether it is private now. */
    private: boolean;
    /** The readers besides its author, the chips a reader may take away. */
    readers?: readonly SealPerson[];
    /** Whether people can be added here: not before the first send, which carries only private or shared. */
    people?: boolean;
    busy?: boolean;
    /** The last save's refusal, in words. */
    error?: string | undefined;
}>();
const emit = defineEmits<{ change: [next: { readonly private: boolean; readonly readers: readonly string[] }] }>();

const addresses = computed(() => readers.map((reader) => reader.email));
const choose = (on: boolean): void => {
    if (on !== closed) {
        emit(`change`, { private: on, readers: addresses.value });
    }
};
const removeReader = (email: string): void => emit(`change`, { private: true, readers: addresses.value.filter((each) => each !== email) });

// Adding someone: the field filters the sandbox's people, and a whole address typed in is a person of its own.
const adding = ref(false);
const query = ref(``);
const candidates = useSealCandidates(() => addresses.value);
const shown = computed((): readonly SealPerson[] => {
    const needle = query.value.trim().toLowerCase();
    const matches = candidates.value.filter((person) => needle === `` || `${person.name ?? ``} ${person.email}`.toLowerCase().includes(needle));
    const typed = typedAddress(query.value);
    const extra: SealPerson[] = typed !== undefined && !matches.some((person) => person.email === typed) && !addresses.value.includes(typed) ? [{ email: typed }] : [];
    return [...matches, ...extra].slice(0, 8);
});
const addReader = (email: string): void => {
    adding.value = false;
    query.value = ``;
    emit(`change`, { private: true, readers: [...addresses.value, email] });
};
const addFirst = (): void => {
    const first = shown.value[0];
    if (first !== undefined) {
        addReader(first.email);
    }
};
</script>

<template>
    <div class="flex flex-col gap-1 p-1" data-seal-choice>
        <div role="radiogroup" :aria-label="t(`chat.seal.who`)" class="flex flex-col">
            <button
                type="button"
                role="radio"
                :aria-checked="!closed"
                :disabled="busy"
                class="ui-row-select flex flex-col rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': !closed }"
                @click="choose(false)"
            >
                <span class="text-sm text-content md:text-xs">{{ t(`chat.seal.shared`) }}</span>
                <span class="text-2xs text-subtle">{{ t(`chat.seal.sharedHint`) }}</span>
            </button>
            <button
                type="button"
                role="radio"
                :aria-checked="closed"
                :disabled="busy"
                class="ui-row-select flex flex-col rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': closed }"
                @click="choose(true)"
            >
                <span class="text-sm text-content md:text-xs">{{ t(`chat.seal.private`) }}</span>
                <span class="text-2xs text-subtle">{{ t(`chat.seal.privateHint`) }}</span>
            </button>
        </div>

        <!-- Who besides the author reads it: a chip each, taken away by its ×, and the press that adds someone. -->
        <div v-if="closed && people" class="flex flex-wrap items-center gap-1 px-2.5 pb-1">
            <span v-for="reader in readers" :key="reader.email" :class="ui.chip({ on: true, lead: true, trail: true })" data-seal-reader>
                <Avatar :size="20" :name="fullName(reader)" :hue="identityHue(reader.email)" />
                <span class="max-w-32 truncate">{{ fullName(reader) }}</span>
                <button
                    type="button"
                    :class="ui.iconButton({ size: `xs`, round: true })"
                    :disabled="busy"
                    :aria-label="t(`chat.seal.removeReader`, { name: fullName(reader) })"
                    @click="removeReader(reader.email)"
                >
                    <Icon name="times" class="text-3xs" />
                </button>
            </span>
            <Button v-if="!adding" size="small" tier="boring" :disabled="busy" :label="t(`chat.seal.addPerson`)" @click="adding = true">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </div>
        <div v-if="closed && people && adding" class="flex flex-col gap-0.5 px-1.5">
            <input
                v-model="query"
                type="text"
                autofocus
                autocomplete="off"
                :placeholder="t(`chat.seal.findPerson`)"
                :aria-label="t(`chat.seal.findPerson`)"
                :class="ui.input({ size: `sm` })"
                class="w-full min-w-0"
                @keydown.enter.prevent="addFirst"
                @keydown.esc.stop.prevent="adding = false"
            />
            <button
                v-for="person in shown"
                :key="person.email"
                type="button"
                class="ui-row-select flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left"
                @click="addReader(person.email)"
            >
                <Avatar :size="20" :name="fullName(person)" :hue="identityHue(person.email)" class="shrink-0" />
                <span class="min-w-0 truncate text-xs text-content">{{ fullName(person) }}</span>
                <span v-if="person.name !== undefined" class="min-w-0 truncate text-2xs text-subtle">{{ person.email }}</span>
            </button>
            <p v-if="shown.length === 0" class="px-2 py-1 text-2xs text-subtle">{{ t(`chat.seal.typeAddress`) }}</p>
        </div>

        <p v-if="error !== undefined" role="alert" class="px-2.5 text-2xs text-danger">{{ error }}</p>
        <p class="border-t border-line px-2.5 pt-2 pb-1 text-2xs leading-snug text-subtle">{{ t(`chat.seal.footnote`) }}</p>
    </div>
</template>
