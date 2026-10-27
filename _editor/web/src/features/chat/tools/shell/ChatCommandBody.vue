<script setup lang="ts">
import { computed } from "vue";
import ChatCommandSection from "./ChatCommandSection.vue";
import ShellTokens from "./ShellTokens.vue";
import type { ShellReading } from "./shellOutput";

// A shell call opened: what the agent said it was doing, then one inset holding the command (a statement per row, after
// the directory it ran in) and each piece of its output in the shape it has (ChatCommandSection), bands ruled apart
// rather than boxed.

const props = defineProps<{
    shell: ShellReading;
    // The agent's own words for the command (Bash's `description`).
    description?: string | undefined;
    openFile?: ((path: string, line?: number) => void) | undefined;
}>();

// The prompt names the directory as a shell prompt does: its last part.
const where = computed(() => props.shell.cwd?.replace(/\/+$/, ``).split(`/`).at(-1));
</script>

<template>
    <div class="ml-[var(--chat-hang)] flex min-w-0 flex-col gap-1">
        <p v-if="description" class="text-xs text-muted">{{ description }}</p>
        <div v-if="shell.rows.length > 0 || shell.sections.length > 0" class="chat-inset min-w-0 overflow-hidden">
            <div
                v-if="shell.rows.length > 0"
                class="flex gap-1.5 px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-muted"
                :class="{ 'chat-inset-rule': shell.sections.length > 0 }"
            >
                <span class="shrink-0 text-subtle select-none" :title="shell.cwd">{{ where === undefined ? `$` : `${where} $` }}</span>
                <div class="min-w-0 flex-1">
                    <div v-for="(row, index) in shell.rows" :key="index" class="whitespace-pre-wrap break-all"><ShellTokens :tokens="row" /></div>
                </div>
            </div>
            <ChatCommandSection
                v-for="(section, index) in shell.sections"
                :key="index"
                :section="section"
                :open-file="openFile"
                :class="{ 'chat-inset-rule': index < shell.sections.length - 1 }"
            />
        </div>
    </div>
</template>
