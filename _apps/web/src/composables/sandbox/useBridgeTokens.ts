import { computed, ref, watch } from "vue";
import { errorMessage, useAsyncAction } from "../useAsyncAction";
import { sandboxJson } from "./sandboxClient";
import { useSandbox } from "./useSandbox";

/* Drives the Editor bridge (ACP) card: owner-minted bridge tokens for the `intentic-acp` stdio bridge that
 * Zed/JetBrains spawn. Mint shows the raw token ONCE (the daemon stores only its hash) plus a ready-to-paste
 * Zed agent_servers snippet; the list supports per-token revocation. The trust model is the sync pairing's
 * (the browser is already the owner), made durable + revocable. */

export interface BridgeToken {
    readonly id: string;
    readonly label: string;
    readonly createdAt: number;
}

export function useBridgeTokens() {
    const { active, daemonUrl } = useSandbox();

    const tokens = ref<readonly BridgeToken[]>([]);
    // The last mint's RAW token — shown once, gone on navigation/sandbox switch, never refetchable.
    const minted = ref<{ readonly token: string; readonly label: string } | undefined>(undefined);
    const { busy: minting, error, run } = useAsyncAction();
    const label = ref(``);

    const refresh = async (): Promise<void> => {
        try {
            tokens.value = (await sandboxJson<{ tokens: BridgeToken[] }>(`/system/bridge/tokens`)).tokens;
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
            const response = await sandboxJson<{ id: string; token: string }>(`/system/bridge/tokens`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(trimmed === `` ? {} : { label: trimmed }),
            });
            minted.value = { token: response.token, label: trimmed === `` ? `editor bridge` : trimmed };
            label.value = ``;
            await refresh();
        }, `Minting failed.`);

    // Deliberately not through `run` — revoking must not flash the mint button's busy state.
    const revoke = async (id: string): Promise<void> => {
        try {
            await sandboxJson(`/system/bridge/tokens/${encodeURIComponent(id)}`, { method: `DELETE` });
        } catch (caught) {
            error.value = errorMessage(caught, `Revoking failed.`);
        }
        await refresh();
    };

    // A paste-ready Zed agent_servers entry for the minted token (JetBrains takes the same command/env).
    const zedSnippet = computed(() => {
        if (minted.value === undefined) {
            return ``;
        }
        const snippet = {
            agent_servers: {
                intentic: {
                    type: `custom`,
                    command: `npx`,
                    args: [`@intentic/acp-bridge`],
                    env: {
                        INTENTIC_SANDBOX_URL: daemonUrl.value ?? ``,
                        INTENTIC_BRIDGE_TOKEN: minted.value.token,
                    },
                },
            },
        };
        return JSON.stringify(snippet, undefined, 2);
    });

    return { tokens, minted, minting, error, label, mint, revoke, refresh, zedSnippet };
}
