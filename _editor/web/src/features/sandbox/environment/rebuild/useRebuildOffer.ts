import { useAsyncAction } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRole } from "../../../../client/sandbox/useRole";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { turnInFlight } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useHostedBuild } from "../../secrets/useHostedBuild";
import { useEnvironment } from "../useEnvironment";
import { hostedBuildPhase } from "./hostedBuildPhase";

// THE REBUILD A BANNER MAY START BY ITSELF, beside "Rebuild needed", where one press is the whole errand and costs
// nobody anything they were not told: a hosted sandbox (the platform builds it, nothing runs on a computer), its owner
// pressing, no build of it under way or failed (the card says what happened), no proposal still to decide (it would be
// built without it), and no agent mid-turn (the swap at the end restarts the sandbox under it). Anywhere else the
// banner's link to the Environment card's own step is the way (rebuildAnchor.ts).
export function useRebuildOffer() {
    const { isOwner } = useRole();
    const { pending, proposal } = useEnvironment();
    const { active } = useSandbox();
    const hosted = computed(() => (active.value?.hosted ? active.value.id : undefined));
    const { build, applied, rebuild } = useHostedBuild(() => hosted.value);
    const { fleet } = useAgents();
    const { busy, notice, run } = useAsyncAction();

    const offered = computed(() => {
        const recipe = pending.value;
        return (
            hosted.value !== undefined &&
            isOwner.value &&
            recipe !== undefined &&
            proposal.value === undefined &&
            hostedBuildPhase(build.value, applied.value, recipe.hash, Date.now()).kind === `idle` &&
            !fleet.value.some(turnInFlight)
        );
    });

    // The content as the daemon shows it; the platform re-hashes it, exactly as the card's own button sends it.
    const start = (): Promise<void> =>
        run(async () => {
            const recipe = pending.value;
            if (recipe !== undefined) {
                await rebuild(recipe.hash, recipe.content);
            }
        }, t(`sandbox.hostedRebuild.couldNotStart`));

    return { offered, busy, notice, start };
}
