import { ref, watch } from "vue";
import { errorMessage, useAsyncAction } from "../useAsyncAction";
import { sandboxJson } from "./sandboxClient";
import { jsonBody } from "./jsonBody";
import { useSandbox } from "./useSandbox";

/* Owner-minted control tokens: the credential anything outside the browser presents to drive this sandbox.
 * Mint shows the raw token ONCE (the daemon stores only its hash); the list supports per-token revocation.
 * The trust model is the sync pairing's (the browser is already the owner), made durable + revocable.
 *
 * The SCOPE is the caller's, not this composable's — a card mints for the thing it is a card for, and the
 * daemon refuses a mint that names no scope. The list is deliberately unfiltered: every token against this
 * sandbox shows up on whichever card you have open, because a revoke surface that only shows you the tokens
 * you happened to mint from this card is how a leaked one stays live. */

// Mirrors ControlScope in the daemon's auth/control-tokens.ts, which owns what each one reaches.
export type ControlScope = "editor" | "read" | "drive" | "land";

export interface ControlToken {
    readonly id: string;
    readonly label: string;
    readonly scope: ControlScope;
    readonly createdAt: number;
}

export function useControlTokens(scope: ControlScope, defaultLabel: string) {
    const { active } = useSandbox();

    const tokens = ref<readonly ControlToken[]>([]);
    // The last mint's RAW token — shown once, gone on navigation/sandbox switch, never refetchable.
    const minted = ref<{ readonly token: string; readonly label: string } | undefined>(undefined);
    const { busy: minting, error, run } = useAsyncAction();
    const label = ref(``);

    const refresh = async (): Promise<void> => {
        try {
            tokens.value = (await sandboxJson<{ tokens: ControlToken[] }>(`/system/control/tokens`)).tokens;
        } catch {
            tokens.value = [];
        }
    };

    watch(
        () => active.value?.id,
        () => {
            minted.value = undefined;
            error.value = undefined;
            void refresh();
        },
        { immediate: true },
    );

    const mint = (): Promise<void> =>
        run(async () => {
            const trimmed = label.value.trim();
            const response = await sandboxJson<{ id: string; token: string }>(
                `/system/control/tokens`,
                jsonBody(`POST`, trimmed === `` ? { scope } : { scope, label: trimmed }),
            );
            minted.value = { token: response.token, label: trimmed === `` ? defaultLabel : trimmed };
            label.value = ``;
            await refresh();
        }, `Minting failed.`);

    // Deliberately not through `run` — revoking must not flash the mint button's busy state.
    const revoke = async (id: string): Promise<void> => {
        try {
            await sandboxJson(`/system/control/tokens/${encodeURIComponent(id)}`, { method: `DELETE` });
        } catch (caught) {
            error.value = errorMessage(caught, `Revoking failed.`);
        }
        await refresh();
    };

    return { tokens, minted, minting, error, label, mint, revoke, refresh };
}
