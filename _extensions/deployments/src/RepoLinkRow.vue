<script setup lang="ts">
import type { DeployRepoLink } from "@intentic/sandbox-contract";
import { Button, Icon, Picker, type PickerOption } from "@intentic/extension-ui";
import { computed, ref } from "vue";

/* One workspace repo that ships a compose file, and the Komodo stack it belongs to.
 *
 * The daemon suggests by name; this is where the owner accepts or overrules. It is deliberately a SUGGESTION
 * and never an automatic binding — only the owner knows that `atlas` is this repo's staging stack, and a guess
 * that silently becomes a fact is worse than no guess. So the accept is one click, the override is a picker
 * over every stack, and unlink is always available. */

const props = defineProps<{ link: DeployRepoLink; stacks: readonly string[]; busy: boolean }>();
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
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-card px-3 py-2">
        <span class="flex min-w-0 items-center gap-2">
            <Icon name="folder" class="shrink-0 text-2xs text-subtle" />
            <span class="truncate text-sm font-medium text-content">{{ link.repo }}</span>
            <span class="truncate font-mono text-2xs text-subtle" v-tooltip.top="link.composePath">{{ link.projectName }}</span>
        </span>

        <span class="ml-auto flex flex-wrap items-center gap-2">
            <template v-if="link.linkedStack !== undefined && !choosing">
                <span class="flex items-center gap-1.5 text-2xs text-success">
                    <Icon name="check-circle" />
                    <span class="font-medium">{{ link.linkedStack }}</span>
                </span>
                <Button size="small" severity="secondary" text :disabled="busy" @click="choosing = true">Change</Button>
                <Button size="small" severity="secondary" text :disabled="busy" @click="emit(`link`, link.repo, ``)">Unlink</Button>
            </template>

            <template v-else-if="!choosing">
                <!-- The good case: the daemon found a stack that looks like this repo, so accepting is one
                     click and the full list stays one click behind it. -->
                <template v-if="suggestion !== undefined">
                    <span class="text-2xs text-muted">
                        looks like <span class="font-medium text-content">{{ suggestion }}</span>
                    </span>
                    <Button size="small" severity="secondary" outlined :disabled="busy" @click="emit(`link`, link.repo, suggestion)">Link</Button>
                    <Button size="small" severity="secondary" text :disabled="busy" @click="choosing = true">Pick another</Button>
                </template>
                <!-- Nothing resembled it. Say so plainly rather than suggesting something arbitrary. -->
                <template v-else>
                    <span class="text-2xs text-subtle">no stack matches this name</span>
                    <Button size="small" severity="secondary" text :disabled="busy || stacks.length === 0" @click="choosing = true"
                        >Choose a stack</Button
                    >
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
                <Button size="small" severity="secondary" text :disabled="busy" @click="choosing = false">Cancel</Button>
            </template>
        </span>
    </div>
</template>
