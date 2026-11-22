<script setup lang="ts">
import type { AgentScriptRun } from "@intentic/sandbox-contract/schemas/agents";
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// A WORKFLOW RUN its parent's agent started, on one line at the head of the parent's tray (ChildRows): its name, the phase
// its script marked, how many of its agents are at work of how many it started, and the Stop that ends it. A run is a
// script, not a conversation: it starts the next agent as each one ends or is stopped, with its parent at rest, so the
// agents under it cannot be stopped one by one. This row is where the reader finds what keeps starting them, and ends it.

// A second press while the first is under way is the same operation, which the ledger runs once (familyStop.ts).
defineProps<{ run: AgentScriptRun }>();
const emit = defineEmits<{ stop: [] }>();

const t = useT();
</script>

<template>
    <!-- A size container, as a child's row is: on a narrow tray the name truncates and the phase gives way first. -->
    <div class="@container flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-xs max-md:min-h-10" data-script-run>
        <span
            class="flex min-w-0 flex-1 items-center gap-1.5 text-content"
            v-tooltip.top="{ title: t(`agents.familyStop.workflowTip`), note: t(`agents.familyStop.workflowNote`) }"
        >
            <Icon name="sitemap" class="shrink-0 text-2xs text-link" />
            <span class="min-w-0 truncate font-medium">{{ run.name }}</span>
            <span v-if="run.phase !== undefined" class="hidden min-w-0 shrink-[2] truncate text-subtle @md:inline">· {{ run.phase }}</span>
        </span>
        <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ t(`agents.familyStop.workflowCounts`, { working: run.working, calls: run.calls }) }}</span>
        <!-- The run's one press; its negative margin keeps the 26px button from making the row taller than a child's. -->
        <Button
            size="small"
            tier="quiet"
            class="-my-1.5 shrink-0"
            :aria-label="t(`agents.familyStop.stop`)"
            v-tooltip.top="{ title: t(`agents.familyStop.stop`), note: t(`agents.familyStop.stopNote`) }"
            @click.stop="emit(`stop`)"
        >
            {{ t(`ui.action.stop`) }}
        </Button>
    </div>
</template>
