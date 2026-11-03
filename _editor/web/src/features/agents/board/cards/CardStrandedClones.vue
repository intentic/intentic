<script setup lang="ts">
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRole } from "../../../../client/sandbox/useRole";
import { turnInFlight } from "../../../../models/agent-status/agentStatus-standing";
import { settleAgentClone } from "../../../../models/fleet/agentActions";
import { useAgents } from "../../../../models/fleet/useAgents";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

// The way out of "a clone of its own: it won't land" (AgentSummary.reach.stranded), under the card's reach line: fold the
// clone into the repository it sits in, so its files land with the rest, or make it a workspace repository of its own
// (the daemon's land/settle/nested-clone.ts). A clone holding commits says what folding drops on the press itself, and the daemon
// folds it only with that count. This sandbox's resting cards only: the press reaches this daemon, and never mid-turn.

const t = useT();
const props = defineProps<{ agent: FleetAgent }>();
const { canShip } = useRole();
const { refresh } = useAgents();

// A sandbox too old to say which repository a clone sits in placed every one in the workspace's own.
const ROOT_REPO = `root`;
const clones = computed(() =>
    (canShip.value && props.agent.sandboxId === undefined && !turnInFlight(props.agent) ? (props.agent.reach?.stranded ?? []) : []).map((clone) => {
        const commits = clone.commits ?? 0;
        const parent = clone.parent ?? ROOT_REPO;
        return {
            dir: clone.dir,
            commits,
            fold: commits > 0 ? t(`agents.cardReach.foldDropping`, { parent, count: commits }, commits) : t(`agents.cardReach.fold`, { parent }),
        };
    }),
);
const busy = ref<string>();
const failed = ref<string>();

const settle = async (dir: string, action: `fold` | `adopt`, commits: number | undefined): Promise<void> => {
    busy.value = dir;
    failed.value = undefined;
    try {
        await settleAgentClone(props.agent.id, dir, action, action === `fold` ? commits : undefined);
        await refresh();
    } catch (error) {
        failed.value = messageOr(error, t(`agents.cardReach.settleFailed`, { dir }));
    } finally {
        busy.value = undefined;
    }
};
</script>

<template>
    <div v-if="clones.length > 0" class="flex min-w-0 flex-col gap-1 text-2xs" data-stranded-clones>
        <div v-for="clone in clones" :key="clone.dir" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <button
                type="button"
                class="text-link underline-offset-2 hover:underline"
                :disabled="busy !== undefined"
                data-fold
                @click.stop="settle(clone.dir, `fold`, clone.commits)"
            >
                {{ clone.fold }}
            </button>
            <button
                type="button"
                class="text-link underline-offset-2 hover:underline"
                :disabled="busy !== undefined"
                data-adopt
                @click.stop="settle(clone.dir, `adopt`, undefined)"
            >
                {{ t(`agents.cardReach.adopt`) }}
            </button>
            <Icon v-if="busy === clone.dir" name="spinner" spin class="text-2xs text-muted" />
        </div>
        <p v-if="failed !== undefined" class="text-danger leading-snug">{{ failed }}</p>
    </div>
</template>
