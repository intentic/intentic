<script setup lang="ts">
import { ui, Row, RowGroup } from "@intentic/ui";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { commitCount } from "./numberInputs";
import SubagentsInfo from "./SubagentsInfo.vue";

/* HOW MUCH THE ASSISTANT MAY DELEGATE. Three ceilings on the same activity, and they are three rows rather than
 * one because they stop different things: the width of one fan-out, the lifetime budget of a conversation, and
 * how far a delegated agent may itself delegate. Raising only the first is what makes a wide sweep hit the second
 * two rounds later — which reads as the same wall in a new place, so all three are shown together.
 *
 * The bounds are the daemon's (SandboxSettingsSchema), restated here so the box refuses a number the save would:
 * a field that accepts 5000 and then silently keeps 200 looks like a setting that didn't take. */
const { settings, patch } = useSandboxSettings();

const AT_ONCE = { min: 1, max: 200 };
const PER_TURN = { min: 1, max: 2000 };
const DEPTH = { min: 1, max: 10 };
</script>

<template>
    <RowGroup label="Subagents">
        <template #info><SubagentsInfo /></template>

        <!-- The parallel width — the one people meet first, because it is the one a fan-out hits within seconds.
             The assistant is told to stop and NOT retry when it lands here, so the cost of a low number is work
             done one item at a time rather than a failure. -->
        <Row
            icon="users"
            title="Subagents at once"
            description="How many delegated agents may work in parallel. Reaching this doesn't fail anything — the assistant is told to stop starting new ones and carry on itself."
        >
            <template #control>
                <input
                    type="number"
                    :min="AT_ONCE.min"
                    :max="AT_ONCE.max"
                    :value="settings?.subagentsAtOnce ?? 20"
                    :disabled="settings === undefined"
                    aria-label="Subagents at once"
                    :class="ui.input('w-20 text-right text-xs')"
                    @change="
                        (event: Event) =>
                            commitCount(event, settings?.subagentsAtOnce ?? 20, AT_ONCE, (subagentsAtOnce: number) => patch({ subagentsAtOnce }))
                    "
                />
            </template>
        </Row>

        <!-- The lifetime budget of one conversation. Separate from the width because it is the cap a long session
             creeps up on rather than one a single message hits — twenty rounds of five is the same hundred agents
             as one round of a hundred, and only this row bounds it. -->
        <Row
            icon="clone"
            title="Subagents per conversation"
            description="The total one conversation may start, across every message in it. Counts every agent ever started, not just the ones still running."
        >
            <template #control>
                <input
                    type="number"
                    :min="PER_TURN.min"
                    :max="PER_TURN.max"
                    :value="settings?.subagentsPerTurn ?? 200"
                    :disabled="settings === undefined"
                    aria-label="Subagents per conversation"
                    :class="ui.input('w-20 text-right text-xs')"
                    @change="
                        (event: Event) =>
                            commitCount(event, settings?.subagentsPerTurn ?? 200, PER_TURN, (subagentsPerTurn: number) => patch({ subagentsPerTurn }))
                    "
                />
            </template>
        </Row>

        <!-- Nesting. The only one of the three whose runaway case multiplies rather than merely widens, which is
             why the warning below is attached to this row and not to the other two. -->
        <Row
            icon="sitemap"
            title="Nesting depth"
            description="How far delegation may go: 1 lets the assistant delegate but stops its agents from delegating in turn."
        >
            <template #control>
                <input
                    type="number"
                    :min="DEPTH.min"
                    :max="DEPTH.max"
                    :value="settings?.subagentDepth ?? 3"
                    :disabled="settings === undefined"
                    aria-label="Nesting depth"
                    :class="ui.input('w-20 text-right text-xs')"
                    @change="
                        (event: Event) => commitCount(event, settings?.subagentDepth ?? 3, DEPTH, (subagentDepth: number) => patch({ subagentDepth }))
                    "
                />
            </template>
            <template #below>
                <p v-if="(settings?.subagentDepth ?? 3) > 3" class="text-2xs text-muted">
                    Each level multiplies the one above it, and every agent at every level spends tokens. The two caps above are what actually bound
                    that — this row only decides how far down it can go.
                </p>
            </template>
        </Row>
    </RowGroup>
</template>
