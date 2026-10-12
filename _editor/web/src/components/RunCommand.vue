<script setup lang="ts">
import { Button, Code, type CommandOs, commandLang, formatElapsed, osOptions, SegmentedControl, useOsPreference } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import ScriptSourceSwitch from "./ScriptSourceSwitch.vue";

// "RUN THIS ON YOUR DEVICE", drawn one way everywhere: the shell choice (the shared preference, so every command on
// every screen follows one pick), the command with its copy button, an optional one-sentence explanation, and for a
// command that carries a single-use code, how long it has left and a way to get a new one. Every card that hands out
// a command uses this rather than assembling a toggle and a code block of its own.

const props = withDefaults(
    defineProps<{
        // A function of the shell for a command offered in both; a string for one that exists in one shell only.
        command: string | ((os: CommandOs) => string);
        // Fixes the shell (no toggle): the command is one shell's, or another command on the card carries the toggle.
        os?: CommandOs;
        // The shell to show first when the device it is for reported one; the reader can still switch.
        defaultOs?: CommandOs;
        // One sentence on what running it does, above the command.
        explanation?: string;
        // What the code block is called for a screen reader.
        label?: string;
        // The dev-only switch between the checkout's script and the published one, for a command pasted elsewhere.
        sourceSwitch?: boolean;
        // When the code it carries lapses (epoch ms): shows the time left and a way to mint a new command.
        expiresAt?: number;
        // A new command is being minted.
        renewing?: boolean;
        copyable?: boolean;
    }>(),
    { copyable: true },
);

const emit = defineEmits<{
    // The reader asked for a new command (the old code lapsed, or was spent).
    renew: [];
}>();

const t = useT();
const { cmdOs } = useOsPreference();

// A plain string is one shell's command; it reads as unix unless told otherwise.
const fixedOs = computed<CommandOs | undefined>(() => props.os ?? (typeof props.command === `string` ? `unix` : undefined));
// A pick here wins over the device's reported shell, and becomes the preference everywhere else too.
const picked = ref<CommandOs | undefined>(undefined);
const shown = computed<CommandOs>({
    get: () => fixedOs.value ?? picked.value ?? props.defaultOs ?? cmdOs.value,
    set: (value) => {
        picked.value = value;
        cmdOs.value = value;
    },
});
const text = computed(() => (typeof props.command === `string` ? props.command : props.command(shown.value)));

// Ticks only while a lapsing command is on screen.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
watch(
    () => props.expiresAt,
    (expiresAt) => {
        clearInterval(timer);
        timer = undefined;
        now.value = Date.now();
        if (expiresAt !== undefined) {
            timer = setInterval(() => {
                now.value = Date.now();
            }, 1000);
        }
    },
    { immediate: true },
);
onBeforeUnmount(() => clearInterval(timer));

const secondsLeft = computed(() => (props.expiresAt === undefined ? undefined : Math.max(0, Math.ceil((props.expiresAt - now.value) / 1000))));
const expired = computed(() => secondsLeft.value === 0);
</script>

<template>
    <div class="flex min-w-0 flex-col gap-2">
        <p v-if="explanation" class="text-xs text-muted">{{ explanation }}</p>
        <div v-if="fixedOs === undefined || sourceSwitch" class="flex min-w-0 flex-wrap items-center gap-2">
            <SegmentedControl v-if="fixedOs === undefined" v-model="shown" size="xs" class="self-start" :options="osOptions()" />
            <ScriptSourceSwitch v-if="sourceSwitch" />
        </div>
        <Code
            :class="{ 'opacity-50': expired }"
            :code="text"
            :lang="commandLang(shown)"
            :label="label ?? t(`common.runCommand.codeLabel`)"
            :copyable="copyable && !expired"
            :wrap="true"
        />
        <p v-if="secondsLeft !== undefined" class="text-2xs text-subtle">
            <template v-if="expired">{{ t(`common.runCommand.expired`) }}</template>
            <template v-else>{{ t(`common.runCommand.expiresIn`, { time: formatElapsed(secondsLeft) }) }}</template>
            <Button class="ml-1" :label="t(`common.runCommand.renew`)" size="small" tier="quiet" tone="accent" :disabled="renewing" @click="emit(`renew`)" />
        </p>
    </div>
</template>
