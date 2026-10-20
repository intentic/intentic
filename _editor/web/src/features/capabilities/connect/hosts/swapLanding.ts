import type { RunningSandbox, SwapAim, SwapVerdict } from "@intentic/sandbox-contract/state/sandbox-build";
import { swapVerdict } from "@intentic/sandbox-contract/state/sandbox-build";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import type { SwapProgress } from "./swapFollow";

// What the sandbox answering right now runs, read fresh rather than from the page's cached reads, which predate the swap:
// its build and the moment its daemon started (/info `running`). HostRecreate reads it at the press and again while it
// follows, and the contract's swapVerdict says whether the swap landed, so a checkout build, whose version is 0.0.0
// before and after, lands like any other.

/** What answers now; undefined from a daemon older than `running`. */
export const answering = async (): Promise<RunningSandbox | undefined> => (await sandboxRpc.system.info()).running;

/**
 * Where a swap aimed at `aim` stands by what answers now (`running`, as `answering` read it). Where nothing could be
 * read (a daemon older than `running`, before the press or after it), answering again after going quiet is the only
 * sign there is, as it always was.
 */
export const swapStanding = (aim: SwapAim, running: RunningSandbox | undefined, now: SwapProgress): SwapVerdict => {
    if (running === undefined || (aim.from === undefined && aim.overlay === undefined)) {
        return now.wentDown ? `landed` : `waiting`;
    }
    return swapVerdict(aim, running);
};
