import {
    type AgentSummary,
    type FixResume,
    type FixStance,
    fixStance,
    latestFixAttempt,
    type MainlinePushRecheckResult,
    type MainlineStatus,
    runPickOf,
} from "@intentic/sandbox-contract";
import type { AgentRunChoice } from "@intentic/ui";
import { computed, type ComputedRef, inject, type InjectionKey, type MaybeRefOrGetter, provide, toValue } from "vue";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { rpcQuery } from "../../sandbox/client/rpcQuery";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";
import { registry } from "../fleet/useAgents-registry";

// The main tree's own check (GET /workspace/mainline): what it is measuring, what waits for it, what it last said and
// who took a red one, and what pushes left behind. Read ONCE per surface that draws it — the chat rail and the agents
// board — and handed to that surface's cards, so a lane of fifty rows is one read and not fifty. The daemon's `mainline`
// push keeps it current. A daemon that does not serve it, or a read that failed, answers nothing, and every mark drawn
// from it then draws nothing rather than a guess.

const MAINLINE_KEY: InjectionKey<ComputedRef<MainlineStatus | undefined>> = Symbol(`mainline`);

// `enabled` for a surface that only wants it for a moment (the review's "Pushed" note), so being mounted costs no read.
export function useMainline(enabled: MaybeRefOrGetter<boolean> = true): ComputedRef<MainlineStatus | undefined> {
    const supported = computed(() => supportsRoute(`workspace.mainline`));
    const { query } = useSandboxQuery({ ...rpcQuery(`workspace.mainline`), enabled: computed(() => supported.value && toValue(enabled)) });
    return computed(() => (!supported.value || query.isError.value ? undefined : query.data.value));
}

// The host's one read, provided to every card below it.
export const provideMainline = (): ComputedRef<MainlineStatus | undefined> => {
    const status = useMainline();
    provide(MAINLINE_KEY, status);
    return status;
};

// What a card reads; nothing outside a host that provides it, so a card drawn anywhere else never starts a read.
export const injectMainline = (): ComputedRef<MainlineStatus | undefined> | undefined => inject(MAINLINE_KEY, undefined);

// THE OWNER'S HANDS ON WHAT A PUSH LEFT. Each press is answered by the daemon changing the status, and the daemon's
// `mainline` push would bring that back on its own; asking again here as well means the press is seen to land in the
// panel that made it even when the stream is a beat behind.
const refreshMainline = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcKey(`workspace.mainline`) });

// Set aside as not to be fixed (every open one in the project when `ids` is left out), or, with `restore`, opened again.
export const dismissPushFindings = async (project: string, ids?: readonly string[], restore = false): Promise<number> => {
    const { changed } = await sandboxRpc.workspace.mainlinePushDismiss({
        project,
        ...(ids === undefined ? {} : { ids: [...ids] }),
        ...(restore ? { restore: true } : {}),
    });
    await refreshMainline();
    return changed;
};

// The project's own push measurement, run again over its main tree now.
export const recheckPushFindings = async (project: string): Promise<MainlinePushRecheckResult> => {
    const result = await sandboxRpc.workspace.mainlinePushRecheck({ project });
    await refreshMainline();
    return result;
};

// The one way an agent is put on them, and only ever on a press. Answers the conversation holding them.
export const handPushFindings = async (project: string, pick?: AgentRunChoice, mode?: FixResume): Promise<string> => {
    const { conversationId } = await sandboxRpc.agents.pushFix({
        project,
        ...(pick === undefined ? {} : { pick: runPickOf(pick) }),
        ...(mode === undefined ? {} : { mode }),
    });
    await refreshMainline();
    return conversationId;
};

// A hand-over's live attempt as the fleet reports it (contract, pushFindingsFixBase names attempt 1): the newest
// attempt at the base, since starting a later one set every earlier one aside. A landed one answered findings that a
// later measurement will settle, so the section offers a fresh press rather than a chip about work already in the tree.
export interface PushFixAttempt {
    readonly agent: AgentSummary;
    readonly attempt: number;
    readonly stance: FixStance;
}

export const usePushFixAttempt = (base: () => string | undefined): ComputedRef<PushFixAttempt | undefined> =>
    computed(() => {
        const id = base();
        const latest = id === undefined ? undefined : latestFixAttempt(id, registry.value);
        if (latest === undefined) {
            return undefined;
        }
        const stance = fixStance(latest.agent);
        return stance.kind === `landed` ? undefined : { agent: latest.agent, attempt: latest.attempt, stance };
    });
