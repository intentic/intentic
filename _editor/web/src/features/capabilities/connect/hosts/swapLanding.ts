import type { RunningSandbox, SwapVerdict } from "@intentic/sandbox-contract/state/sandbox-build";
import { swapVerdict } from "@intentic/sandbox-contract/state/sandbox-build";
import { sandboxRaw } from "../../../../client/sandbox/sandboxRaw";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import type { SwapProgress } from "./swapFollow";

// What the sandbox answering right now runs, read fresh rather than from the page's cached reads, which predate the swap:
// its build and the moment its daemon started (/info `running`). HostRecreate reads it at the press and again while it
// follows, and the contract's swapVerdict says whether the swap landed, so a checkout build, whose version is 0.0.0
// before and after, lands like any other. A daemon older than `running` is told as every swap was before it.

/** What answers now; undefined from a daemon older than `running`. */
export const answering = async (): Promise<RunningSandbox | undefined> => (await sandboxRpc.system.info()).running;

/** What answered at the press or answers now: its build and boot, or what a daemon older than `running` says instead. */
export interface Answered {
    readonly running?: RunningSandbox;
    /** The version it was built as, which an update or a rollback moves. */
    readonly version?: string | undefined;
    /** sha256 of the overlay its container was built from, which a rebuild aims at; undefined on a stock image. */
    readonly appliedHash?: string | undefined;
}

/** What a daemon older than `running` says instead: for a rebuild aimed at `overlay` the overlay it runs, else its version. */
export const olderAnswer = async (overlay: string | undefined): Promise<Answered> =>
    overlay === undefined
        ? { version: (await sandboxRpc.system.info()).version }
        : { appliedHash: (await sandboxRaw(`GET /environment`)).appliedHash };

/**
 * Where a swap aimed at `overlay` (a rebuild) or away from what answered at the press (`from`) stands by what answers
 * now. A daemon older than `running` answering is told as before it: a rebuild by the overlay it runs, an update or a
 * rollback by moving off the version it was pressed on, since its answering again says nothing (a blink mid-download is
 * no landing). Where nothing read at the press can tell, answering again after going quiet is the only sign there is.
 */
export const swapStanding = (
    aim: { readonly from: Answered | undefined; readonly overlay: string | undefined },
    answered: Answered,
    now: SwapProgress,
): SwapVerdict => {
    const { from, overlay } = aim;
    if (answered.running === undefined) {
        if (overlay !== undefined) {
            return answered.appliedHash === overlay ? `landed` : `waiting`;
        }
        if (from?.version !== undefined) {
            return answered.version === from.version ? `waiting` : `landed`;
        }
    } else if (overlay !== undefined || from?.running !== undefined) {
        return swapVerdict({ from: from?.running, overlay }, answered.running);
    }
    return now.wentDown ? `landed` : `waiting`;
};
