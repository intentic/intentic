import { messageOr, useNow } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, type Ref, ref } from "vue";
import { type LimitGroup, limitGroups, limited } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";

// The Attention lane's one press for agents a provider's spent allowance stopped together (agentStatus.limitGroups):
// "Resume all when it's back" books every held turn at the reset, where the provider published one, or "Resume all"
// sends them all again now, where it did not. Pressing Continue down a lane of seven stopped subagents was the only way
// before, one refusal at a time.

export interface ResumeAllHost {
    readonly fleet: Readonly<Ref<readonly FleetAgent[]>>;
    // Re-runs one held turn now (useAgents.resumeHeldTurn).
    readonly resumeHeldTurn: (id: string) => Promise<void>;
    // Answers one conversation's limit with a resend, which the resume pass fires at the reset (useAgents.setBreakPolicy).
    readonly resendAtReset: (id: string) => Promise<void>;
    // The board's must-read strip, for a press that failed.
    readonly notice: Ref<string | undefined>;
}

export const useResumeAll = (host: ResumeAllHost) => {
    // Ticks only while some card is stopped by a limit: a reset passing turns "when it's back" into "now".
    const now = useNow(() => host.fleet.value.some(limited));
    const groups = computed<LimitGroup[]>(() => limitGroups(host.fleet.value, now.value));
    // Providers whose press is out, so a second press waits for the first.
    const busy = ref<ReadonlySet<string>>(new Set());
    const resume = async (group: LimitGroup): Promise<void> => {
        if (busy.value.has(group.provider)) {
            return;
        }
        busy.value = new Set(busy.value).add(group.provider);
        const press = group.reopensAt === undefined ? host.resumeHeldTurn : host.resendAtReset;
        try {
            const answers = await Promise.allSettled(group.ids.map((id) => press(id)));
            const refused = answers.find((answer): answer is PromiseRejectedResult => answer.status === `rejected`);
            if (refused !== undefined) {
                host.notice.value = messageOr(refused.reason, t(`agents.resumeAll.couldntResumeEvery`));
            }
        } finally {
            const left = new Set(busy.value);
            left.delete(group.provider);
            busy.value = left;
        }
    };
    return { groups, busy, resume };
};
