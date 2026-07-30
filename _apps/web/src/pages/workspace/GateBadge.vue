<script setup lang="ts">
import type { GateVerdict } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic-app/ui";
import { computed, ref } from "vue";
import { useChat } from "../../composables/chat/useChat";
import { useGate } from "../../composables/workspace/useGate";

/* THE LANDING GATE'S BADGE — one strip above the commit box saying whether this tree would survive CI.
 *
 * The verdict is computed long before it is read (the daemon runs the check once the fleet goes quiet, see
 * gate/gate.ts), which is the whole point of the placement: the user arrives at the commit box and the answer is
 * already there. Nothing here blocks the commit. The panel states what it knows and the user decides — a gate
 * that disabled Commit would be a gate that stops the user shipping a fix for the gate itself.
 *
 * Sized for the ~270px sidebar, so it obeys the panel's rules: one line of status, one labelled primary action,
 * everything else an icon with a tooltip. The failure output is a hover card rather than an expander, because a
 * strip that grows to twenty lines pushes the review it is supposed to introduce off the screen.
 */

const gate = useGate();
const actionError = ref<string | undefined>(undefined);

const act = async (action: () => Promise<string | undefined>): Promise<void> => {
    actionError.value = await action();
};

// What the strip SAYS, per status. Each line is written to be read at a glance and to be true when stale —
// "was passing" rather than "passing", because a stale verdict's subject is a tree that no longer exists.
const headline = computed((): string => {
    const verdict = gate.verdict.value;
    if (verdict.fix?.outcome === `running`) {
        return `Agent is fixing the checks…`;
    }
    switch (verdict.status) {
        case `armed`:
            return `Checks queued`;
        case `running`:
            return `Running checks…`;
        case `passed`:
            return verdict.stale ? `Checks passed on an earlier tree` : `Checks passed`;
        case `failed`:
            return verdict.timedOut === true ? `Checks timed out` : `Checks failed`;
        case `error`:
            return `Checks couldn't run`;
        case `cancelled`:
            return `Checks stopped`;
        default:
            return `Checks haven't run`;
    }
});

const tone = computed((): { border: string; text: string; icon: IconName } => {
    const verdict = gate.verdict.value;
    if (verdict.status === `failed`) {
        return { border: `border-danger/40 bg-danger/10`, text: `text-danger`, icon: `exclamation-triangle` };
    }
    if (verdict.status === `error` || verdict.status === `cancelled`) {
        return { border: `border-warning/40 bg-warning/10`, text: `text-warning`, icon: `exclamation-circle` };
    }
    if (verdict.status === `passed`) {
        // A stale pass is a heads-up, not a green light: it was true of a tree that has since moved.
        return verdict.stale
            ? { border: `border-line bg-canvas`, text: `text-muted`, icon: `history` }
            : { border: `border-success/40 bg-success/10`, text: `text-success`, icon: `check-circle` };
    }
    return { border: `border-line bg-canvas`, text: `text-muted`, icon: gate.busy.value ? `spinner` : `clock` };
});

// The agents the failure implicates, as one line. Named agents with paths read as the accusation; the no-paths
// case is deliberately worded as company rather than blame (see GateAgentSchema).
const implicated = computed((): string | undefined => {
    const { implicated: agents, status } = gate.verdict.value;
    if (status !== `failed` || agents.length === 0) {
        return undefined;
    }
    const named = agents.map((agent) => agent.title ?? agent.agentId.slice(0, 8));
    const pinpointed = agents.some((agent) => agent.paths.length > 0);
    return pinpointed ? `Names files from ${named.join(`, `)}` : `Landed work from ${named.join(`, `)}`;
});

const durationLabel = computed((): string | undefined => {
    const { startedAt, finishedAt } = gate.verdict.value;
    if (startedAt === undefined || finishedAt === undefined) {
        return undefined;
    }
    const seconds = Math.round((finishedAt - startedAt) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
});

const fixSession = computed((): string | undefined => gate.verdict.value.fix?.sessionId);
</script>

<template>
    <!-- Nothing at all when no check command is configured: an empty gate has no opinion, and a strip that says
         so would spend a row of the sidebar on a feature the user has not turned on. -->
    <div v-if="!gate.off.value" class="shrink-0 border-b border-line p-2">
        <div :class="['flex items-start gap-1.5 rounded-md border px-2 py-1.5', tone.border]">
            <Icon :name="tone.icon" :spin="gate.busy.value" :class="['mt-0.5 shrink-0 text-2xs', tone.text]" />
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1">
                    <p :class="['min-w-0 flex-1 truncate text-2xs font-medium', tone.text]" v-tooltip.right.overflow="gate.verdict.value.command">
                        {{ headline }}
                    </p>
                    <span v-if="durationLabel && !gate.busy.value" class="shrink-0 text-2xs text-subtle">{{ durationLabel }}</span>
                </div>

                <!-- Who is implicated, and the output that says so. The output rides a tooltip on the same line
                     rather than its own block: it is evidence for the headline, read on demand. -->
                <p v-if="implicated" class="mt-0.5 truncate text-2xs text-muted" v-tooltip.right.overflow="gate.verdict.value.output || implicated">
                    {{ implicated }}
                </p>
                <p v-else-if="gate.verdict.value.status === `error`" class="mt-0.5 break-words text-2xs text-muted">
                    {{ gate.verdict.value.output }}
                </p>

                <!-- Actions. `Fix with agent` is the primary one whenever there is something to fix, because it
                     is the whole reason the gate ran; otherwise the primary is running the check itself. -->
                <div class="mt-1 flex items-center gap-1">
                    <button
                        v-if="gate.verdict.value.status === `failed` && gate.verdict.value.fix?.outcome !== `running`"
                        type="button"
                        class="rounded border border-line px-1.5 py-0.5 text-2xs font-medium text-content transition-colors hover:bg-overlay"
                        @click="act(gate.fix)"
                    >
                        Fix with agent
                    </button>
                    <button
                        v-if="gate.busy.value"
                        type="button"
                        class="rounded border border-line px-1.5 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay"
                        @click="act(gate.cancel)"
                    >
                        Stop
                    </button>
                    <button
                        v-else
                        type="button"
                        class="rounded border border-line px-1.5 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay"
                        @click="act(gate.run)"
                    >
                        {{ gate.verdict.value.status === `idle` ? `Run checks` : `Re-run` }}
                    </button>
                    <!-- The fix turn has no fleet card to open (it runs on the main tree, by necessity — see
                         gate/gate.ts), so its transcript is the only way to see what it did. -->
                    <button
                        v-if="fixSession"
                        type="button"
                        class="rounded p-0.5 text-subtle transition-colors hover:bg-overlay hover:text-content"
                        v-tooltip.right="`Open the fix transcript`"
                        aria-label="Open the fix transcript"
                        @click="void useChat().openConversation(fixSession)"
                    >
                        <Icon name="comments" class="text-2xs" />
                    </button>
                </div>

                <p v-if="actionError" class="mt-0.5 break-words text-2xs text-danger">{{ actionError }}</p>
            </div>
        </div>
    </div>
</template>
