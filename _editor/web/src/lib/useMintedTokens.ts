import { noticeFrom, useAsyncAction } from "@intentic/ui/async";
import { shallowRef, watch } from "vue";

// A credential list where minting answers the raw value once and the server keeps only its digest.
export interface TokenSource<Token, Request, Minted> {
    readonly list: () => Promise<readonly Token[]>;
    readonly mint: (request: Request) => Promise<Minted>;
    // The live list when the answer carries one; undefined reads it again.
    readonly revoke: (id: string) => Promise<readonly Token[] | undefined>;
    // Whose tokens these are; a change drops the shown secret and reads the list again.
    readonly owner?: () => unknown;
}

export function useMintedTokens<Token, Request, Minted>(source: TokenSource<Token, Request, Minted>) {
    const tokens = shallowRef<readonly Token[]>([]);
    // The last mint's raw value, never refetchable.
    const minted = shallowRef<Minted>();
    const { busy: minting, notice, run } = useAsyncAction();

    // A list that didn't load is said, not shown as "no tokens": a live token nobody can see is one nobody revokes.
    const refresh = async (): Promise<void> => {
        try {
            tokens.value = await source.list();
        } catch (caught) {
            tokens.value = [];
            notice.value ??= noticeFrom(caught, `Couldn't load the tokens.`);
        }
    };

    watch(
        source.owner ?? (() => undefined),
        () => {
            minted.value = undefined;
            notice.value = undefined;
            void refresh();
        },
        { immediate: true },
    );

    const mint = (request: Request): Promise<void> =>
        run(async () => {
            minted.value = await source.mint(request);
            await refresh();
        }, `Minting failed.`);

    // Not routed through `run`: revoking must not flash the mint button's busy state.
    const revoke = async (id: string): Promise<void> => {
        let live: readonly Token[] | undefined;
        try {
            live = await source.revoke(id);
        } catch (caught) {
            notice.value = noticeFrom(caught, `Couldn't revoke that token.`);
        }
        if (live === undefined) {
            await refresh();
            return;
        }
        tokens.value = live;
    };

    return { tokens, minted, minting, notice, mint, revoke };
}
