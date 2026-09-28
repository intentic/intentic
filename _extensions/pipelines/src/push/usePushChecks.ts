import { type FixResume, type PushChecks, type PushDismiss, type PushFix, type PushRecheckResult, runPickOf } from "@intentic/sandbox-contract";
import type { AgentRunChoice } from "@intentic/extension-ui";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type ComputedRef } from "vue";
import { refreshPushAttention } from "../ciAttention";
import { host } from "../host";
import { pushChecksQuery } from "./pushChecksQuery";
import { fixesKey } from "../fixes/useCiFixes";

// What pushes left behind, and the owner's three hands on it: dismiss (or undo one), measure again, hand to an agent.
// The daemon's `pushes` push keeps the read current; every press also asks again itself, so it is seen to land on the
// board that made it even when the stream is a beat behind, and nudges the rail's poll so the tile moves with it.

// A floor under the stream, like the CI board's: what a push left changes on a push, a press or a land, never by itself.
const POLL_MS = 60_000;

export interface PushChecksHands {
    // Unset while the first read is out, and for a daemon that serves no push record or a read that failed: every mark
    // drawn from it then draws nothing rather than a guess.
    readonly checks: ComputedRef<PushChecks | undefined>;
    // Set aside as not to be fixed (every open one in the project when `ids` is left out), or, with `restore`, opened
    // again. Answers how many changed.
    readonly dismiss: (project: string, ids?: readonly string[], restore?: boolean) => Promise<number>;
    // The project's own push measurement, run again over its main tree now.
    readonly recheck: (project: string) => Promise<PushRecheckResult>;
    // The one way an agent is put on them, and only ever on a press. Answers the conversation holding them.
    readonly handOver: (project: string, pick: AgentRunChoice | undefined, mode: FixResume | undefined) => Promise<string>;
}

export function usePushChecks(): PushChecksHands {
    const api = host();
    const queryClient = useQueryClient();
    const spec = pushChecksQuery();
    const query = useQuery({ ...spec, enabled: computed(() => api.sandbox.reachable()), refetchInterval: POLL_MS });

    const settle = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: spec.queryKey });
        refreshPushAttention();
    };

    return {
        checks: computed(() => (query.isError.value ? undefined : query.data.value)),
        dismiss: async (project, ids, restore = false) => {
            const input: PushDismiss = { project };
            if (ids !== undefined) {
                input.ids = [...ids];
            }
            if (restore) {
                input.restore = true;
            }
            const { changed } = await api.sandbox.rpc.workspace.pushDismiss(input);
            await settle();
            return changed;
        },
        recheck: async (project) => {
            const result = await api.sandbox.rpc.workspace.pushRecheck({ project });
            await settle();
            return result;
        },
        handOver: async (project, pick, mode) => {
            const input: PushFix = { project };
            if (pick !== undefined) {
                input.pick = runPickOf(pick);
            }
            if (mode !== undefined) {
                input.mode = mode;
            }
            try {
                const { conversationId } = await api.sandbox.rpc.agents.pushFix(input);
                return conversationId;
            } finally {
                // Answered or refused, the fleet is where the answer shows: a press refused because an attempt is already
                // running on them is answered by that attempt's chip, which a stale read of the fleet would not draw.
                await Promise.all([settle(), queryClient.invalidateQueries({ queryKey: fixesKey() })]);
            }
        },
    };
}
