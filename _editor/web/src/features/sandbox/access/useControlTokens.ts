import type { ControlScope } from "@intentic/sandbox-contract";
import { noticeFrom, useAsyncAction } from "@intentic/ui/async";
import { ref, watch } from "vue";
import { jsonBody } from "../client/jsonBody";
import { sandboxJson } from "../client/sandboxClient";
import { useSandbox } from "../client/useSandbox";

/* Owner-minted control tokens: the credential anything outside the browser presents to drive this sandbox.
 * Mint shows the raw token ONCE (the daemon stores only its hash); the list supports per-token revocation.
 * The trust model is the sync pairing's (the browser is already the owner), made durable + revocable.
 *
 * The SCOPE and the EXPIRY are the mint's arguments, not this composable's: the Access tab mints any rung, the
 * Devices card mints the editor slice, and the daemon refuses a mint that names no scope. The list is
 * deliberately unfiltered: every token against this sandbox shows up on whichever surface you have open,
 * because a revoke surface that only shows you the tokens you happened to mint from this card is how a leaked
 * one stays live. */

export interface ControlToken {
    readonly id: string;
    readonly label: string;
    readonly scope: ControlScope;
    readonly createdAt: number;
    readonly createdBy?: string;
    readonly expiresAt?: number;
    readonly lastUsedAt?: number;
}

export interface MintRequest {
    readonly label: string;
    readonly scope: ControlScope;
    // Epoch ms; absent mints a token that lives until revoked.
    readonly expiresAt?: number;
}

export function useControlTokens() {
    const { active } = useSandbox();

    const tokens = ref<readonly ControlToken[]>([]);
    // The last mint's RAW token, shown once, gone on navigation/sandbox switch, never refetchable.
    const minted = ref<{ readonly token: string; readonly label: string; readonly scope: ControlScope } | undefined>(undefined);
    const { busy: minting, notice, run } = useAsyncAction();

    const refresh = async (): Promise<void> => {
        try {
            tokens.value = (await sandboxJson<{ tokens?: ControlToken[] }>(`/system/control/tokens`)).tokens ?? [];
        } catch {
            tokens.value = [];
        }
    };

    watch(
        () => active.value?.id,
        () => {
            minted.value = undefined;
            notice.value = undefined;
            void refresh();
        },
        { immediate: true },
    );

    const mint = (request: MintRequest): Promise<void> =>
        run(async () => {
            const label = request.label.trim();
            const response = await sandboxJson<{ id: string; token: string }>(
                `/system/control/tokens`,
                jsonBody(`POST`, {
                    scope: request.scope,
                    ...(label === `` ? {} : { label }),
                    ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
                }),
            );
            minted.value = { token: response.token, label: label === `` ? request.scope : label, scope: request.scope };
            await refresh();
        }, `Minting failed.`);

    // Deliberately not through `run`, revoking must not flash the mint button's busy state.
    const revoke = async (id: string): Promise<void> => {
        try {
            await sandboxJson(`/system/control/tokens/${encodeURIComponent(id)}`, { method: `DELETE` });
        } catch (caught) {
            notice.value = noticeFrom(caught, `Couldn't revoke that token.`);
        }
        await refresh();
    };

    return { tokens, minted, minting, notice, mint, revoke, refresh };
}
