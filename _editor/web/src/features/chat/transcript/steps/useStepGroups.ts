import type { AgentJob } from "@intentic/sandbox-contract/schemas/agents";
import { computed, type Ref, shallowRef, watch } from "vue";
import type { ChatTurn } from "../../../../models/conversations/transcript/transcript";
import { type MergedSteps, type StepGroup, stepGroupsOf, stepsFold } from "./stepGroups";

// A pane's step groups (stepGroups.ts) and which of them the reader opened. Open is kept here rather than in the group,
// since a group's tail is a row of its own that opens and shuts with it.

export interface StepGroupsHost {
    readonly turns: Readonly<Ref<readonly ChatTurn[]>>;
    readonly cuts: Readonly<Ref<ReadonlyMap<number, number>>>;
    readonly doomed: Readonly<Ref<ReadonlySet<number>>>;
    // The row still being written, kept out of every group.
    readonly live: Readonly<Ref<number | undefined>>;
    readonly jobs: Readonly<Ref<readonly AgentJob[] | undefined>>;
    readonly showToolCalls: Readonly<Ref<boolean>>;
    readonly conversationId: Readonly<Ref<string>>;
}

export const useStepGroups = (host: StepGroupsHost) => {
    const groups = computed(() => stepGroupsOf(host.turns.value, host.cuts.value, host.doomed.value, host.live.value));
    const opened = shallowRef<ReadonlySet<number>>(new Set());
    watch(host.conversationId, () => {
        opened.value = new Set();
    });
    const folds = (group: StepGroup): boolean => stepsFold(group, host.jobs.value, host.showToolCalls.value);
    const isOpen = (group: StepGroup): boolean => opened.value.has(group.head);
    // How a group's own runs draw: undefined while each member draws as it would alone.
    const merged = (group: StepGroup, last: boolean): MergedSteps | undefined => {
        if (!folds(group)) {
            return undefined;
        }
        if (!isOpen(group)) {
            return `shut`;
        }
        return last ? `open-last` : `open`;
    };
    return {
        groups,
        folds,
        isOpen,
        setOpen: (group: StepGroup, open: boolean): void => {
            const next = new Set(opened.value);
            if (open) {
                next.add(group.head);
            } else {
                next.delete(group.head);
            }
            opened.value = next;
        },
        // A member's run: never the last, since a group with members only carries the press itself (ChatStepGroup).
        memberSteps: (group: StepGroup): MergedSteps | undefined => merged(group, false),
        // A tail's run, by the tail's id; undefined for any other row.
        tailSteps: (id: number): MergedSteps | undefined => {
            const group = groups.value.tails.get(id);
            return group === undefined ? undefined : merged(group, true);
        },
        // What a head row's drawing depends on, as one value for the pane's v-memo.
        headState: (id: number): string | undefined => {
            const group = groups.value.heads.get(id);
            return group === undefined ? undefined : `${folds(group)}:${isOpen(group)}`;
        },
    };
};
