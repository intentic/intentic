<script setup lang="ts">
import type { DeployRepoLink } from "./contract";
import { Button, cmp, Icon, Picker, type PickerOption, StatusBadge } from "@intentic/extension-ui";
import { computed, ref } from "vue";

/* One workspace repo that ships a compose file, and the Komodo stack it belongs to. A hairline row inside the
 * "Your repos" <RowGroup> — it draws no border of its own, for the reason spelled out in ResourceRow.
 *
 * The daemon suggests by name; this is where the owner accepts or overrules. It is deliberately a SUGGESTION
 * and never an automatic binding — only the owner knows that `atlas` is this repo's staging stack, and a guess
 * that silently becomes a fact is worse than no guess. So the accept is one click, the override is a picker
 * over every stack, and unlink is always available. */

// `error` is whatever the link call refused with, shown on this row rather than in a page banner — the same
// rule ResourceRow follows, and for the same reason.
const props = defineProps<{ link: DeployRepoLink; stacks: readonly string[]; busy: boolean; error: string | undefined }>();
const emit = defineEmits<{ link: [repo: string, stack: string] }>();

// Open the picker on demand rather than always: with a good suggestion the one-click accept is the whole
// interaction, and a select box beside it would make the easy path look like a decision.
const choosing = ref(false);
const chosen = ref<string | undefined>(props.link.linkedStack);

const options = computed<PickerOption[]>(() => props.stacks.map((stack) => ({ value: stack, label: stack })));
const suggestion = computed(() => props.link.suggestions[0]);

const apply = (stack: string | undefined): void => {
    if (stack === undefined) {
        return;
    }
    choosing.value = false;
    emit(`link`, props.link.repo, stack);
};
</script>

<template>
    <div class="px-4 py-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span class="flex min-w-0 items-center gap-2.5">
                <Icon name="folder" class="shrink-0 text-muted" />
                <span class="min-w-0">
                    <span class="block truncate text-sm font-medium text-content">{{ link.repo }}</span>
                    <span class="block truncate font-mono text-2xs text-subtle" v-tooltip.top="link.composePath">{{ link.projectName }}</span>
                </span>
            </span>

            <span class="ml-auto flex flex-wrap items-center gap-2">
                <template v-if="link.linkedStack !== undefined && !choosing">
                    <!-- Linked IS a state, so it wears the app's state pill rather than a hand-drawn tick. -->
                    <StatusBadge variant="success" size="xs" dot :label="link.linkedStack" />
                    <Button label="Change" size="small" severity="secondary" text :disabled="busy" @click="choosing = true" />
                    <Button label="Unlink" size="small" severity="secondary" text :disabled="busy" @click="emit(`link`, link.repo, ``)" />
                </template>

                <template v-else-if="!choosing">
                    <!-- The good case: the daemon found a stack that looks like this repo, so accepting is one
                         click and the full list stays one click behind it. -->
                    <template v-if="suggestion !== undefined">
                        <span class="text-2xs text-muted">
                            looks like <span class="font-medium text-content">{{ suggestion }}</span>
                        </span>
                        <Button label="Link" size="small" :disabled="busy" @click="emit(`link`, link.repo, suggestion)" />
                        <Button label="Pick another" size="small" severity="secondary" text :disabled="busy" @click="choosing = true" />
                    </template>
                    <!-- Nothing resembled it. Say so plainly rather than suggesting something arbitrary. -->
                    <template v-else>
                        <span class="text-2xs text-subtle">no stack matches this name</span>
                        <Button
                            label="Choose a stack"
                            size="small"
                            severity="secondary"
                            text
                            :disabled="busy || stacks.length === 0"
                            @click="choosing = true"
                        />
                    </template>
                </template>

                <template v-else>
                    <Picker
                        v-model="chosen"
                        :options="options"
                        :disabled="busy"
                        placeholder="Choose a stack"
                        aria-label="Komodo stack"
                        class="text-xs"
                        @update:model-value="apply"
                    />
                    <Button label="Cancel" size="small" severity="secondary" text :disabled="busy" @click="choosing = false" />
                </template>
            </span>
        </div>

        <div v-if="error" :class="cmp.alertDanger(`mt-2 break-words`)">{{ error }}</div>
    </div>
</template>
