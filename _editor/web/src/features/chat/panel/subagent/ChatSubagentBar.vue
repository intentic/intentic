<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import type { AgentProvider } from "@intentic/sandbox-contract";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { formatElapsed } from "../../../agents/fleet/agentStatus";
import { childLook } from "../../../agents/board/cards/childLook";
import { inProcess, type TrayChild } from "../../../agents/board/view/childFold";
import { relativeTime } from "../../models/catalog";

// WHERE THE COMPOSER STANDS WHEN THE CHAT IS A SUBAGENT'S. A subagent is its parent's to direct: the parent wrote its
// ask, reads its report, and decides what it does next, so a box to type into here would invite words the parent never
// hears. The bar takes the box's place rather than leaving a hole, since a composer that vanishes reads as the app
// breaking: it says whose subagent this is, with the way back to that parent as the first thing on it, and how the
// subagent stands, in the same glyph and clock its row in the parent's tray wears (childLook).
//
// A spawned subagent is a conversation of its own, so the reader may still speak to it directly, a press away ("Write to
// it"), and stop it while it works. One its parent's runtime ran in-process has no conversation to send to at all.

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
</script>

<template>
    <div role="group" :aria-label="t(`shared.subagent`)" class="flex flex-col gap-1 rounded-2xl border border-line bg-overlay px-2 py-2 shadow-lg">
        <div class="flex min-w-0 items-center gap-1 text-xs">
            <!-- The parent first, as the way back: the breadcrumb a reader follows out of the subagent they stepped into. -->
            <button
                type="button"
                class="ui-row-select flex min-w-0 max-w-[45%] shrink items-center gap-1.5 rounded-md px-1.5 py-1 text-muted hover:text-content"
                v-tooltip.top="{ title: t(`chat.chatSubagentBar.back`), rows: [{ label: t(`chat.chatSubagentBar.parent`), value: props.parentTitle }] }"
                :aria-label="t(`chat.chatSubagentBar.backTo`, { title: props.parentTitle })"
                @click="emit(`back`)"
            >
                <Icon name="arrow-left" class="shrink-0 text-2xs" />
                <span class="truncate">{{ props.parentTitle }}</span>
            </button>
            <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
            <span class="flex min-w-0 flex-1 items-center gap-1.5 px-1">
                <Icon
                    :name="look.glyph.icon"
                    :spin="look.glyph.spin"
                    role="img"
                    :aria-label="look.glyph.label"
                    v-tooltip.top="look.hint"
                    class="shrink-0 text-xs"
                    :class="look.glyph.class"
                />
                <span class="min-w-0 truncate font-medium text-content">{{ look.title }}</span>
                <span v-if="look.tag !== undefined" class="shrink-0 text-2xs text-subtle">{{ look.tag }}</span>
            </span>
            <span
                v-if="look.working && look.since !== undefined && look.since > 0"
                v-tooltip.top="look.doing"
                class="shrink-0 px-1 text-2xs font-medium tabular-nums text-link"
                >{{ formatElapsed(look.since, now) }}</span
            >
            <span v-else-if="look.at > 0" class="shrink-0 px-1 text-2xs text-subtle">{{ relativeTime(look.at) }}</span>
        </div>
        <div class="flex min-w-0 items-center gap-2 pl-2">
            <p class="min-w-0 flex-1 text-2xs text-subtle">
                {{ spawned ? t(`chat.chatSubagentBar.spawnedNote`) : t(`chat.chatSubagentBar.inProcessNote`) }}
            </p>
            <Button v-if="spawned" size="small" severity="secondary" :text="true" class="shrink-0" @click="emit(`write`)">
                <Icon name="pencil" class="text-2xs" />{{ t(`chat.chatSubagentBar.write`) }}
            </Button>
            <Button v-if="stoppable" size="small" severity="secondary" class="shrink-0" @click="emit(`stop`)">
                <Icon name="stop" class="text-2xs" />{{ t(`ui.action.stop`) }}
            </Button>
        </div>
    </div>
</template>
