<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { computed } from "vue";
import { FILE_SIDE_VIEW, type FileArrival, fileSideInput, noteArrival } from "../../workbench/side/sideFileInput";
import { openBeside } from "../../workbench/side/sideTabs";

// One line over a peeked file saying how the reference reached it, when that is not simply "it named this file": it is
// one of several the reference could mean, with a way through the rest, or the conversation renamed it since.

const { path, agent, arrival } = defineProps<{ path: string; agent?: string; arrival: Readonly<FileArrival> }>();

const t = useT();

const matches = computed(() => arrival.matches ?? []);
const at = computed(() => matches.value.indexOf(path));

// The next or previous match, wrapping, in this tab's place; the list rides along so that one's bar reads the same.
const step = (by: 1 | -1): void => {
    const count = matches.value.length;
    const next = matches.value[(at.value + by + count) % count];
    if (next === undefined) {
        return;
    }
    const input = fileSideInput(next, agent);
    noteArrival(input, { asked: arrival.asked, matches: matches.value });
    openBeside(FILE_SIDE_VIEW, input);
};
</script>

<template>
    <div class="flex min-h-7 shrink-0 items-center gap-2 border-b border-line bg-card px-3 text-2xs text-muted">
        <span v-if="arrival.renamedFrom !== undefined" class="flex min-w-0 items-center gap-1.5" :title="arrival.renamedFrom">
            <Icon name="history" class="shrink-0 text-[0.7rem]" />
            <span class="truncate">{{ t(`shell.sidePanel.renamedFrom`, { name: basename(arrival.renamedFrom) }) }}</span>
        </span>
        <template v-if="matches.length > 1 && at !== -1">
            <span class="min-w-0 flex-1 truncate" :title="arrival.asked">
                {{ t(`shell.sidePanel.oneOfMatches`, { at: at + 1, count: matches.length, path: arrival.asked }) }}
            </span>
            <Button tier="quiet" size="small" :aria-label="t(`shell.sidePanel.previousMatch`)" v-tooltip.bottom="t(`shell.sidePanel.previousMatch`)" @click="step(-1)">
                <Icon name="arrow-left" />
            </Button>
            <Button tier="quiet" size="small" :aria-label="t(`shell.sidePanel.nextMatch`)" v-tooltip.bottom="t(`shell.sidePanel.nextMatch`)" @click="step(1)">
                <Icon name="arrow-right" />
            </Button>
        </template>
    </div>
</template>
