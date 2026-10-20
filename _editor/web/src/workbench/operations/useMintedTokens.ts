import { useLoaded } from "@intentic/extension-api";
import { messageOr, type NoticeModel, noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, shallowRef, watch } from "vue";
import { useOperation } from "./operations";

// A credential list where minting answers the raw value once and the server keeps only its digest.
export interface TokenSource<Token, Request, Minted> {
    readonly list: () => Promise<readonly Token[]>;
    readonly mint: (request: Request) => Promise<Minted>;
    // The live list when the answer carries one; undefined reads it again.
    readonly revoke: (id: string) => Promise<readonly Token[] | undefined>;
    // Whose tokens these are; a change reads the list again, and the shown secret is that owner's own.
    readonly owner?: () => unknown;
    // Which kind of token this list mints, as the operations ledger files its runs: one per surface, so a token minted
    // on one is never shown on another.
    readonly key?: string;
}

// THE MINTED VALUE IS THE MINT'S, NOT THE VIEW'S. It is shown once and can never be read again, so the run that minted
// it sits in the operations ledger, kept until put away (`forgetMinted`) or replaced by the next mint: a reader who
// leaves to paste it into a CI secret and comes back still finds it, and a mint still being answered holds the button
// on the view opened again.
export function useMintedTokens<Token, Request, Minted>(source: TokenSource<Token, Request, Minted>) {
    // This owner's list as last read; undefined until it has been, and again when the owner changes.
    const listed = shallowRef<readonly Token[]>();
    const reading = shallowRef(false);
    const readFailure = shallowRef<string>();
    const kind = source.key ?? `tokens/minted`;
    const minting = useOperation<Minted>(() => (source.owner === undefined ? kind : `${kind}/${String(source.owner())}`));
    // The last mint's raw value, never refetchable.
    const minted = computed(() => (minting.operation.value?.state === `done` ? minting.value.value : undefined));
    // What the list itself said: a read or a revoke that failed. A failed mint is the ledger's.
    const listNotice = shallowRef<NoticeModel>();
    const notice = computed(() => listNotice.value ?? minting.failure.value);

    // A list that didn't load is said, not shown as "no tokens": a live token nobody can see is one nobody revokes.
    const refresh = async (): Promise<void> => {
        reading.value = true;
        try {
            listed.value = await source.list();
            readFailure.value = undefined;
        } catch (caught) {
            listed.value = undefined;
            readFailure.value = messageOr(caught, t(`common.useMintedTokens.couldntLoad`));
            listNotice.value ??= noticeFrom(caught, t(`common.useMintedTokens.couldntLoad`));
        } finally {
            reading.value = false;
        }
    };
    // What a view draws the list from (<Await :of>): waiting until this owner's list is read, never another's.
    const loaded = useLoaded(() => ({ data: listed.value, error: readFailure.value, fetching: reading.value, wanted: true, retry: () => void refresh() }));

    watch(
        source.owner ?? (() => undefined),
        () => {
            listNotice.value = undefined;
            listed.value = undefined;
            void refresh();
        },
        { immediate: true },
    );

    const mint = async (request: Request): Promise<void> => {
        if (minting.busy.value) {
            return;
        }
        listNotice.value = undefined;
        await minting.run({
            what: t(`common.useMintedTokens.minting`),
            failed: t(`common.useMintedTokens.mintingFailed`),
            keep: true,
            task: async () => {
                const value = await source.mint(request);
                await refresh();
                return value;
            },
        });
    };

    // Puts the shown value away, once the reader has it somewhere safe.
    const forgetMinted = (): void => minting.dismiss();

    // Not a ledger run: revoking must not flash the mint button's busy state, and the list read after it is its answer.
    const revoke = async (id: string): Promise<void> => {
        let live: readonly Token[] | undefined;
        try {
            live = await source.revoke(id);
        } catch (caught) {
            listNotice.value = noticeFrom(caught, t(`common.useMintedTokens.couldntRevoke`));
        }
        if (live === undefined) {
            await refresh();
            return;
        }
        listed.value = live;
    };

    return { tokens: computed(() => listed.value ?? []), minted, minting: minting.busy, notice, mint, forgetMinted, revoke, loaded };
}
