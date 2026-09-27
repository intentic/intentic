import { type FixResume, type PushChecks, runPickOf } from "@intentic/sandbox-contract";
import type { AgentRunChoice } from "@intentic/ui";
import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { rpcQuery } from "../../sandbox/client/rpcQuery";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";

// WHAT PUSHES LEFT BEHIND (GET /workspace/push-checks): every push the pre-push hook measured, and per project what it
// let through that is still owed (the project's push Red). The hook never refuses a push, so this is where its findings
// wait; the Pipelines view lists them. Here is only what the push flow and the review's "Pushed" note need: the red a
// refused push was filed under, and the one press that hands it to an agent. The daemon's `pushes` push keeps it
// current. A daemon that does not serve it, or a read that failed, answers nothing, and whatever is drawn from it then
// says nothing rather than a guess.

// Whether the daemon serves the record at all; one from before it answers nothing, which is not "nothing was left".
export const pushChecksServed = (): boolean => supportsRoute(`workspace.pushChecks`);

// `enabled` for a surface that wants it only for a moment (the review's "Pushed" note), so being mounted costs no read.
export function usePushChecks(enabled: MaybeRefOrGetter<boolean> = true): ComputedRef<PushChecks | undefined> {
    const { query } = useSandboxQuery({ ...rpcQuery(`workspace.pushChecks`), enabled: computed(() => pushChecksServed() && toValue(enabled)) });
    return computed(() => (!pushChecksServed() || query.isError.value ? undefined : query.data.value));
}

// The one way an agent is put on what pushes left, and only ever on a press. Answers the conversation holding them. The
// daemon's `pushes` push would bring the record back on its own; asking again here as well means the press is seen to
// land in the surface that made it even when the stream is a beat behind.
export const handPushFindings = async (project: string, pick?: AgentRunChoice, mode?: FixResume): Promise<string> => {
    const { conversationId } = await sandboxRpc.agents.pushFix({
        project,
        ...(pick === undefined ? {} : { pick: runPickOf(pick) }),
        ...(mode === undefined ? {} : { mode }),
    });
    await queryClient.invalidateQueries({ queryKey: rpcKey(`workspace.pushChecks`) });
    return conversationId;
};
