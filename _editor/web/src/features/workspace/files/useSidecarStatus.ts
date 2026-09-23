import type { SidecarStatus } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { rpcQuery } from "../../sandbox/client/rpcQuery";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { sidecarQueue } from "../changes/live/useWorkspaceLive";

/* How the background rendering pass is doing. Its own module rather than a function in derivedText.ts, which is
   route calls and path predicates that anything may import without dragging the query client in behind them. */

/**
 * Fetched once and then carried by `derivedChanged` frames, which arrive on every run of the pass — polling would ask
 * the same question the stream already answers, and this is work with no request of its own to hang an update on.
 */
export function useSidecarStatus(): { status: ComputedRef<SidecarStatus | undefined> } {
    const { query } = useSandboxQuery(rpcQuery(`workspace.derivedStatus`));
    // The pushed value wins the moment one arrives: the fetch only answers for the window before the first frame.
    return { status: computed<SidecarStatus | undefined>(() => sidecarQueue.value ?? query.data.value) };
}
