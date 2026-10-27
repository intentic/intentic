<!-- One block of the environment as its chip opens it: a peek while the pointer rests on the chip, the whole of it once pressed. -->
<script setup lang="ts">
import type { EnvironmentItem } from "@intentic/sandbox-contract/schemas/environment";
import { BrandMark, Button, Code, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { attribution, stateOf } from "./environmentItem";
import { environmentVisual } from "./environmentVisual";

const t = useT();

const {
    item,
    full = false,
    removable = false,
    operable = false,
    busy = false,
} = defineProps<{
    item: EnvironmentItem;
    // Pressed open rather than peeked at: the whole explanation, what it installs, and the way to take it out.
    full?: boolean;
    // This reader may take this block out (the card's owner gate, and a block the sandbox names).
    removable?: boolean;
    // This reader may change the environment at all, so a capability's block can say where it is turned off.
    operable?: boolean;
    // A decision elsewhere on the card is on its way, so none is started here meanwhile.
    busy?: boolean;
}>();
// Asks for this block to be taken out; the card confirms it, naming the tool, before anything is posted.
const emit = defineEmits<{ remove: [] }>();

const state = computed(() => stateOf(item));
const visual = computed(() => environmentVisual(item));
const from = computed(() => attribution(item));

// The peek says the one line everyone reads; the opened card the paragraph an agent wrote, which overlaps that line by
// design rather than continuing past it, so the two are never shown together.
const paragraphs = computed(() => (full ? (item.detail ?? item.purpose ?? ``) : (item.purpose ?? ``)).split(`\n\n`));
// Splits at the agent's own paragraph break, not a line count, so "there is more" is a fact about the text.
const all = ref(false);
const shown = computed(() => (all.value ? paragraphs.value.join(`\n\n`) : (paragraphs.value[0] ?? ``)));
const more = computed(() => full && paragraphs.value.length > 1);

// The capability's own card is where its cost is turned off: its blocks have no Remove of their own.
const viaCapability = computed(() => full && operable && !removable && item.origin === `capability`);
</script>

<template>
    <div class="flex min-h-0 flex-col gap-3 overflow-y-auto p-3" :data-environment-card="full ? `open` : `peek`">
        <div class="flex min-w-0 items-center gap-2">
            <BrandMark plain :size="20" :name="item.name" :logo="visual.logo" :icon="visual.icon" :idle="item.state !== `active`" />
            <span class="min-w-0 flex-1 truncate text-sm font-medium text-content">{{ item.name }}</span>
            <span v-if="state" class="inline-flex shrink-0 items-center gap-1 text-2xs font-medium" :class="state.tone">
                <Icon :name="state.icon" />{{ t(`sandbox.environmentContents.${state.words}`) }}
            </span>
        </div>

        <!-- Rendered as prose, not code: it was written to be read. -->
        <div v-if="shown !== ``" class="flex flex-col items-start gap-1">
            <p class="whitespace-pre-line text-xs leading-relaxed text-muted">{{ shown }}</p>
            <button v-if="more" type="button" :class="ui.textButton({ size: `xs`, tone: `quiet` })" @click="all = !all">
                {{ all ? t(`ui.action.showLess`) : t(`sandbox.environmentContents.showMore`) }}
                <Icon :name="all ? `chevron-up` : `chevron-down`" />
            </button>
        </div>

        <!-- Quiet label, clear value, as a sidebar's properties: every binary it puts on PATH, and who pulled it in. -->
        <dl v-if="item.tools.length > 0 || from !== undefined" class="flex flex-col gap-1.5 text-2xs">
            <div v-if="item.tools.length > 0" class="flex gap-3">
                <dt class="w-12 shrink-0 text-subtle">{{ t(`sandbox.environmentContents.tools`) }}</dt>
                <!-- One binary a line, its version in a column of its own, so a toolchain reads as a table, not a run-on. -->
                <dd class="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono tabular-nums">
                    <template v-for="tool in item.tools" :key="tool.name">
                        <span class="truncate text-content">{{ tool.name }}</span>
                        <span class="truncate text-subtle">{{ tool.version ?? `` }}</span>
                    </template>
                </dd>
            </div>
            <div v-if="from !== undefined" class="flex gap-3">
                <dt class="w-12 shrink-0 text-subtle">{{ t(`sandbox.environmentContents.from`) }}</dt>
                <dd class="min-w-0 text-content">{{ from }}</dd>
            </div>
        </dl>

        <template v-if="full">
            <!-- The plumbing count: the least useful fact, so only in the opened card. -->
            <p v-if="item.extras !== undefined" class="text-2xs text-subtle">
                {{ t(`sandbox.environmentContents.plusLibrariesHeadersCommands`, { extras: item.extras }) }}
            </p>
            <!-- Clamped: a toolchain's install step can run to many lines. -->
            <Code
                v-if="item.commands !== undefined"
                :code="item.commands"
                lang="docker"
                :label="t(`sandbox.environmentContents.whatInstalls`)"
                :clamp-lines="10"
            />
            <p v-if="viaCapability" class="text-2xs text-subtle">
                {{ t(`sandbox.environmentContents.goesWithCapability`) }}
                <RouterLink to="/capabilities" class="font-medium text-link hover:underline">{{
                    t(`sandbox.environmentContents.capabilitiesLink`)
                }}</RouterLink>
            </p>
            <!-- Under what it installs: taking a tool out is read about before it is pressed. -->
            <Button
                v-if="removable"
                :label="t(`sandbox.environmentContents.removeFromEnvironment`)"
                size="small"
                tier="quiet"
                tone="danger"
                :disabled="busy"
                class="self-start"
                @click="emit(`remove`)"
            >
                <template #icon><Icon name="trash" /></template>
            </Button>
        </template>
    </div>
</template>
