import type { PreviewGuardScope } from "@intentic/sandbox-contract/schemas/ports";
import type { PickerOption } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { useAccess } from "../../../../client/sandbox/access/useAccess";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { queryClient } from "../../../../lib/queryPersistence";
import { useOperation } from "../../../../workbench/operations/operations";

// Who may open this sandbox's previews from outside (sandbox-contract schemas/ports.ts): anyone with the address, or
// only its members, for app previews alone or forwarded ports too. Every member reads it, so a maintainer sharing a
// preview's address knows whether it will open for the person they send it to; whoever runs people and access changes it,
// since who may open a preview is who gets in. A daemon older than the guard serves every preview openly and has no switch to show.

// The three choices in a person's words, in the order they close: built when read, so a language switch reaches them.
export const previewGuardChoices = (): readonly PickerOption<PreviewGuardScope>[] => [
    { value: `off`, label: t(`sandbox.previewGuardSection.off`), hint: t(`sandbox.previewGuardSection.offHint`), icon: `globe` },
    { value: `panels`, label: t(`sandbox.previewGuardSection.panels`), hint: t(`sandbox.previewGuardSection.panelsHint`), icon: `users` },
    { value: `all`, label: t(`sandbox.previewGuardSection.all`), hint: t(`sandbox.previewGuardSection.allHint`), icon: `lock` },
];

export function usePreviewGuard() {
    const { holds } = useAccess();
    const served = computed(() => supportsRoute(`ports.previewGuard`));
    const mayChange = computed(() => holds(`people`));
    const read = rpcQuery(`ports.previewGuard`);
    const { query, error, locked } = useSandboxQuery({ ...read, enabled: served });
    // The sandbox's, in the operations ledger: the section opened again mid-write holds its picker.
    const changing = useOperation(`access/previews/guard`);
    const scope = computed<PreviewGuardScope | undefined>(() => query.data.value?.scope);

    // The daemon's answer is the state afterwards, put where the read keeps it, so the picker redraws from its word.
    const choose = async (next: PreviewGuardScope): Promise<void> => {
        if (changing.busy.value || next === scope.value) {
            return;
        }
        await changing.run({
            what: t(`sandbox.previewGuardSection.changing`),
            failed: t(`sandbox.previewGuardSection.couldntChange`),
            // The picker shows the new choice where it was made.
            quiet: true,
            task: async () => {
                const answer = await sandboxRpc.ports.setPreviewGuard({ scope: next });
                queryClient.setQueryData(read.queryKey.value, answer);
            },
        });
    };

    return {
        served,
        mayChange,
        scope,
        // A read the person's access refuses (a guest's) is no failure: the section is simply not theirs.
        locked: computed(() => locked.value !== undefined),
        readError: error,
        busy: changing.busy,
        failure: changing.failure,
        choose,
    };
}
