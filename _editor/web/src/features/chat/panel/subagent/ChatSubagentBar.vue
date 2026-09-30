<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import type { AgentProvider } from "@intentic/sandbox-contract";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { formatElapsed } from "../../../agents/fleet/agentStatus";
import { childLook } from "../../../agents/board/cards/childLook";
import RunFacts from "../../../agents/board/cards/RunFacts.vue";
import { inProcess, type TrayChild } from "../../../agents/board/view/childFold";
import { relativeTime } from "../../models/catalog";

// WHERE THE COMPOSER STANDS WHEN THE CHAT IS A SUBAGENT'S. A subagent is its parent's to direct: the parent wrote its
// ask, reads its report, and decides what it does next, so a box to type into here would invite words the parent never
// hears. The bar takes the box's place rather than leaving a hole, since a composer that vanishes reads as the app
// breaking, and says in four places, each with a job of its own, what the composer would have:
//   whose it is: the parent, as the way back, a breadcrumb above the rest;
//   which it is and how it stands: its title, with its standing and clock in one pill at the end (childLook, the same
//   glyph and clock its row in the parent's tray wears);
//   what it is: the model and tier it runs on (RunFacts; its kind is only the title's hover), where the composer's picker would name them;
//   what the reader can do: one short line on why there is no box, and the presses there are instead.
//
// A spawned subagent is a conversation of its own, so the reader may still speak to it directly ("Write to it") and stop
// it while it works. One its parent's runtime ran in-process has no conversation to send to: its press is the parent's.

const props = defineProps<{
    // The subagent: a conversation the parent spawned, or the roster's record of one its runtime ran in-process.
    child: TrayChild;
    // The parent's title, and the provider it runs on: a subagent is named by its provider only when that differs.
    parentTitle: string;
    provider: AgentProvider;
    // Offer the press that stops it: a spawned one whose turn is running.
    stoppable?: boolean;
}>();
const emit = defineEmits<{ back: []; stop: []; write: [] }>();

const t = useT();

const look = computed(() => childLook(props.child, props.provider));
const now = useNow(() => look.value.working);
const spawned = computed(() => !inProcess(props.child));
// The clock the pill carries: how long it has worked, else when it settled.
const clock = computed(() =>
    look.value.working && look.value.since !== undefined && look.value.since > 0
        ? formatElapsed(look.value.since, now.value)
        : look.value.at > 0
          ? relativeTime(look.value.at)
          : undefined,
);
</script>

<template>
    <div role="group" :aria-label="t(`shared.subagent`)" class="flex flex-col rounded-2xl border border-line bg-overlay shadow-lg">
        <div class="flex min-w-0 flex-col gap-1 px-3 pt-2 pb-2.5">
            <!-- Whose it is, first and smallest: the breadcrumb a reader follows out of the subagent they stepped into. -->
            <button
                type="button"
                class="ui-row-select -ml-1.5 flex max-w-full min-w-0 items-center gap-1.5 self-start rounded-md px-1.5 py-0.5 text-2xs text-muted hover:text-content"
                :aria-label="t(`chat.chatSubagentBar.backTo`, { title: props.parentTitle })"
                @click="emit(`back`)"
            >
                <Icon name="arrow-left" class="shrink-0 text-2xs" />
                <span class="truncate">{{ props.parentTitle }}</span>
            </button>
            <!-- Which it is, and how it stands: the title leads, its standing and clock close the line in one pill. -->
            <div class="flex min-w-0 items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-sm font-medium text-content" v-tooltip.top="look.titleHint">{{ look.title }}</span>
                <span
                    class="ui-status-pill flex shrink-0 items-center gap-1.5 text-2xs tabular-nums"
                    :class="look.working ? 'bg-link/10 font-medium text-link' : 'bg-content/5 text-subtle'"
                    v-tooltip.top="look.working ? look.doing : undefined"
                >
                    <Icon
                        :name="look.glyph.icon"
                        :spin="look.glyph.spin"
                        role="img"
                        :aria-label="look.glyph.label"
                        class="shrink-0 text-2xs"
                        :class="look.working ? '' : look.glyph.class"
                    />
                    <span>{{ clock ?? look.glyph.label }}</span>
                </span>
            </div>
            <!-- What it runs on, each a chip, where the composer's picker would name them. -->
            <div v-if="look.run !== undefined" class="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5">
                <RunFacts :run="look.run" chips />
            </div>
        </div>
        <!-- What the reader can do instead of typing: why there is no box, and the presses there are. -->
        <div class="flex min-w-0 items-center gap-2 border-t border-line py-1.5 pr-1.5 pl-3">
            <p class="min-w-0 flex-1 text-2xs text-subtle">
                {{ spawned ? t(`chat.chatSubagentBar.spawnedNote`) : t(`chat.chatSubagentBar.inProcessNote`) }}
            </p>
            <Button v-if="!spawned" size="small" severity="secondary" :text="true" class="shrink-0" @click="emit(`back`)">
                <Icon name="arrow-left" class="text-2xs" />{{ t(`chat.chatSubagentBar.writeParent`) }}
            </Button>
            <Button v-if="spawned" size="small" severity="secondary" :text="true" class="shrink-0" @click="emit(`write`)">
                <Icon name="pencil" class="text-2xs" />{{ t(`chat.chatSubagentBar.write`) }}
            </Button>
            <Button v-if="stoppable" size="small" severity="secondary" class="shrink-0" @click="emit(`stop`)">
                <Icon name="stop" class="text-2xs" />{{ t(`ui.action.stop`) }}
            </Button>
        </div>
    </div>
</template>
