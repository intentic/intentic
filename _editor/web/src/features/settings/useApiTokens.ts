import type { ApiToken, ApiTokenScope } from "@intentic/api-contract";
import { noticeFrom, useAsyncAction } from "@intentic/ui/async";
import { onMounted, ref } from "vue";
import { apiClient } from "../../lib/useApi";

// ACCOUNT tokens, the platform's, not a sandbox's: the credential that acts for the person outside a browser. The
// sandbox's own control tokens (access/useControlTokens.ts) are the same idea one level down, and deliberately
// separate — one names this machine, one names the account, and neither opens the other's doors.
//
// Mint returns the raw value once; the platform stores only its digest. Every mutation answers with the whole list,
// so two tabs cannot disagree about what is live.

export function useApiTokens() {
    const tokens = ref<readonly ApiToken[]>([]);
    // The last mint's raw value; shown once, never refetchable, and cleared the moment this page goes away.
    const minted = ref<{ readonly token: string; readonly label: string } | undefined>(undefined);
    const { busy: minting, notice, run } = useAsyncAction();

    const refresh = async (): Promise<void> => {
        try {
            tokens.value = (await apiClient.token.list()).tokens;
        } catch {
            tokens.value = [];
        }
    };

    onMounted(() => void refresh());

    const mint = (label: string, scope: ApiTokenScope): Promise<void> =>
        run(async () => {
            const named = label.trim();
            const created = await apiClient.token.create({ label: named === `` ? scope : named, scope });
            minted.value = { token: created.token, label: created.label };
            await refresh();
        }, `Minting failed.`);

    // Not routed through `run`: revoking must not flash the mint button's busy state.
    const revoke = async (tokenId: string): Promise<void> => {
        try {
            tokens.value = (await apiClient.token.revoke({ tokenId })).tokens;
        } catch (caught) {
            notice.value = noticeFrom(caught, `Couldn't revoke that token.`);
            await refresh();
        }
    };

    return { tokens, minted, minting, notice, mint, revoke, refresh };
}
