import type { HostedBuildState } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { useOperation } from "../../../../workbench/operations/operations";

// Asking the platform to build a hosted sandbox's approved recipe, from the Environment card's button or the banner's
// own press: one key for both, so either shows the other's ask under way, and neither sends a second over it. Kept in
// the operations ledger, not the view, since the ask lands whether or not the card or the menu is still open; the build
// it starts is the platform's, read back by useHostedBuild.
export const useHostedRebuildStart = (rebuild: (hash: string, content: string) => Promise<HostedBuildState>) => {
    const start = useOperation<void>(`environment/hosted-rebuild`);
    const run = async (hash: string, content: string): Promise<void> => {
        if (start.busy.value) {
            return;
        }
        await start.run({
            what: t(`sandbox.hostedRebuild.starting`),
            done: () => t(`sandbox.hostedRebuild.started`),
            failed: t(`sandbox.hostedRebuild.couldNotStart`),
            task: async () => {
                await rebuild(hash, content);
            },
        });
    };
    return { busy: start.busy, notice: start.failure, run };
};
