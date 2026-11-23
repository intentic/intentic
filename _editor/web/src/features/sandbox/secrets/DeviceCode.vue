<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { nextTick, useTemplateRef, watch } from "vue";

// A DEVICE SIGN-IN'S CODE, read rather than typed: one tile per character, sized to read from a second screen, copied by
// a press on it as well as by the icon beside it. The copying is the panel's (ConnectFlow.vue), since the press that
// opens the provider's page copies it too; this draws the code and each press's answer. A copy the browser refused
// leaves the code in a field already selected, since text inside a button cannot be selected by hand everywhere.

const t = useT();

const { code, refused, justCopied, presses, announcement } = defineProps<{
    code: string;
    refused: boolean;
    justCopied: boolean;
    // Counts the presses, so one made while the last one's Copied is still up redraws it and is announced again.
    presses: number;
    // What the live region says, so a press is heard as well as seen.
    announcement: string;
}>();
const emit = defineEmits<{ copy: [event: Event] }>();

const field = useTemplateRef<HTMLInputElement>(`field`);
watch(
    () => refused,
    async (now) => {
        if (now) {
            await nextTick();
            field.value?.focus();
            field.value?.select();
        }
    },
);
</script>

<template>
    <div class="relative flex flex-wrap items-center gap-2">
        <input
            v-if="refused"
            ref="field"
            readonly
            :value="code"
            :aria-label="t(`sandbox.connectFlow.codeLabel`)"
            :class="ui.input(`w-48 font-mono font-semibold tracking-[0.2em]`)"
            @focus="field?.select()"
        />
        <button
            v-else
            type="button"
            class="flex flex-wrap items-center gap-1 rounded-lg text-left font-mono text-lg font-semibold text-content"
            :title="t(`sandbox.connectFlow.copyCode`)"
            @click="emit(`copy`, $event)"
        ><span
                v-for="(character, index) in [...code]"
                :key="index"
                :class="character === `-` ? `px-0.5 text-subtle` : `flex h-10 w-8 items-center justify-center rounded-md border border-line-strong bg-canvas`"
                >{{ character }}</span
            ></button>
        <!-- allow(recipes): A COPY GLYPH THAT SAYS "COPIED" for a beat after the press: while the word shows,
             the box is the word's width, then it is the glyph's square again. -->
        <button
            type="button"
            :aria-label="t(`sandbox.connectFlow.copyCode`)"
            :class="ui.iconButton({ tone: `subtle` }, justCopied && `w-auto px-1.5 text-success`)"
            @click="emit(`copy`, $event)"
        >
            <!-- Keyed by the press, so each one pops its own tick (the checkbox's) rather than leaving the last one standing. -->
            <span
                :key="justCopied ? presses : 0"
                class="flex items-center gap-1 text-2xs"
                :class="{ 'motion-safe:animate-[ui-check-in_160ms_cubic-bezier(0.2,0.9,0.3,1.25)]': justCopied }"
            >
                <Icon :name="justCopied ? `check` : `copy`" />
                <span v-if="justCopied" aria-hidden="true">{{ t(`ui.action.copied`) }}</span>
            </span>
        </button>
        <span class="sr-only" aria-live="polite"
            ><span :key="presses">{{ announcement }}</span></span
        >
    </div>
</template>
