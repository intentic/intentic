import { NamespaceSetupError } from "../../../workload/namespace-holder.js";
import type { IsolationAnchor, IsolationPlan } from "../isolation.js";
import { layerDirOf } from "../mount-table.js";
import { OVERLAY_FS_NAME, setLayerAside } from "./overlay-layers.js";
import { sandboxLayers } from "../turn-sandbox.js";

// THE ANCHOR'S ONE REPAIR, made before anything is asked of the model, so the request the turn then sends is the one it
// would have sent anyway and the provider's cache of the conversation is untouched: a holder that refused one of the
// conversation's overlays is tried once more over fresh layers, its old ones set aside (overlay-layers.ts setLayerAside).
// A refusal that names no overlay, or a plan with no layers of its own, is no layer's doing and goes up as it came; so
// does the second attempt's failure, for the turn to be refused at the door as `workspace-broken` (setup-refusal.ts).
// 2026-11-05: a kernel marker left in one layer's work dir refused every turn of a conversation until a person pressed
// Continue twenty times; that marker is now cleared up front (prepareLayer), and this catches what nobody has met yet.

// bwrap words a refused mount "Can't make overlay mount …", and mount(8) names the fs type it failed on (ours).
const LAYER_REFUSED = new RegExp(`overlay|${OVERLAY_FS_NAME}`, "iu");

// The layers of the conversation's own a plan mounts: a fenced or jailed sandbox's (turn-sandbox.ts), else its mirrors.
// None for the main tree, whose plan may name the workspace itself as where layers live (turn-sandbox.ts jailPlanOf).
const ownLayers = (plan: IsolationPlan): readonly string[] => {
    if (plan.worktree === plan.root) {
        return [];
    }
    return plan.fence === undefined ? plan.mirrors : sandboxLayers({ ...plan, fence: plan.fence });
};

// How many of the plan's own layers held something to set aside.
const setLayersAside = async (plan: IsolationPlan): Promise<number> => {
    const stamp = new Date().toISOString().replaceAll(":", "-");
    let set = 0;
    for (const rel of ownLayers(plan)) {
        set += (await setLayerAside(layerDirOf(plan, rel), stamp)) ? 1 : 0;
    }
    return set;
};

/** `start`, and once more over fresh layers when what refused it was one of the plan's own overlays. */
export const withLayerRepair = async (
    plan: IsolationPlan,
    start: () => Promise<IsolationAnchor>,
    onRepair?: (layers: number, error: NamespaceSetupError) => void,
): Promise<IsolationAnchor> => {
    try {
        return await start();
    } catch (error) {
        // allow(dependency-text): bwrap's and mount(8)'s words for a refused overlay; a wording neither matches is not repaired and goes up as workspace-broken.
        if (!(error instanceof NamespaceSetupError) || error.transient || !LAYER_REFUSED.test(error.message)) {
            throw error;
        }
        const layers = await setLayersAside(plan);
        if (layers === 0) {
            throw error;
        }
        onRepair?.(layers, error);
        return start();
    }
};
