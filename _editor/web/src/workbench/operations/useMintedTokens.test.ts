import { effectScope, ref, type EffectScope } from "vue";
import { type TokenSource, useMintedTokens } from "./useMintedTokens";
import { forgetOperations } from "./operations";

afterEach(() => {
    forgetOperations();
});

const settled = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const refusing: TokenSource<string, never, string> = {
    list: (): Promise<readonly string[]> => Promise.reject(new Error(`daemon unreachable`)),
    mint: (): Promise<string> => Promise.reject(new Error(`unused`)),
    revoke: (): Promise<readonly string[] | undefined> => Promise.reject(new Error(`revocation refused`)),
};

const mounted = async (
    source: TokenSource<string, never, string> = refusing,
): Promise<{ scope: EffectScope; minted: ReturnType<typeof useMintedTokens<string, never, string>> }> => {
    const scope = effectScope();
    const minted = scope.run(() => useMintedTokens(source));
    if (minted === undefined) {
        throw new Error(`the scope did not run`);
    }
    await settled();
    return { scope, minted };
};

describe(`useMintedTokens`, () => {
    it(`says a token list failed to load rather than showing it as empty`, async () => {
        const { scope, minted } = await mounted();
        expect({ tokens: minted.tokens.value, notice: minted.notice.value }).toEqual({
            tokens: [],
            notice: { tone: `danger`, title: `Couldn't load the tokens.`, detail: `daemon unreachable`, action: undefined, key: undefined },
        });
        scope.stop();
    });

    it(`keeps a failed revocation's notice when the relist after it fails too`, async () => {
        let lists = 0;
        const { scope, minted } = await mounted({
            ...refusing,
            list: () => (++lists === 1 ? Promise.resolve([`token-1`]) : refusing.list()),
        });
        await minted.revoke(`token-1`);
        expect(minted.notice.value).toEqual({
            tone: `danger`,
            title: `Couldn't revoke that token.`,
            detail: `revocation refused`,
            action: undefined,
            key: undefined,
        });
        scope.stop();
    });

    // The raw value is shown once and never again: a reader who leaves to paste it somewhere and comes back must still
    // find it, until they put it away.
    it(`keeps a minted value across the view going away, until it is put away`, async () => {
        let answer: (value: string) => void = () => {};
        const source: TokenSource<string, string, string> = {
            list: () => Promise.resolve([]),
            mint: () => new Promise<string>((resolve) => (answer = resolve)),
            revoke: () => Promise.resolve(undefined),
            key: `tests/tokens`,
        };
        const first = effectScope();
        const view = first.run(() => useMintedTokens(source));
        const minting = view?.mint(`ci`);
        first.stop();

        const again = effectScope();
        const back = again.run(() => useMintedTokens(source));
        expect(back?.minting.value).toBe(true);
        answer(`ict_secret`);
        await minting;
        await settled();
        expect(back?.minted.value).toBe(`ict_secret`);
        again.stop();

        // Read once and left: still there, since it is kept rather than seen-and-gone.
        const third = effectScope();
        const kept = third.run(() => useMintedTokens(source));
        expect(kept?.minted.value).toBe(`ict_secret`);
        kept?.forgetMinted();
        expect(kept?.minted.value).toBeUndefined();
        third.stop();
    });

    it(`exposes an initial loading state while the first list query is out`, async () => {
        let finishList: (tokens: readonly string[]) => void = () => {};
        const source: TokenSource<string, never, string> = {
            ...refusing,
            list: () => new Promise((resolve) => {
                finishList = resolve;
            }),
        };
        const scope = effectScope();
        const minted = scope.run(() => useMintedTokens(source));
        if (minted === undefined) {
            throw new Error(`the scope did not run`);
        }
        expect(minted.initialLoading.value).toBe(true);
        expect(minted.loading.value).toBe(true);
        expect(minted.tokens.value).toEqual([]);

        finishList([`token-1`]);
        await settled();

        expect(minted.initialLoading.value).toBe(false);
        expect(minted.loading.value).toBe(false);
        expect(minted.tokens.value).toEqual([`token-1`]);
        scope.stop();
    });

    it(`clears the initial loading state even when the list query rejects`, async () => {
        let rejectList: (err: Error) => void = () => {};
        const source: TokenSource<string, never, string> = {
            ...refusing,
            list: () => new Promise((_, reject) => {
                rejectList = reject;
            }),
        };
        const scope = effectScope();
        const minted = scope.run(() => useMintedTokens(source));
        if (minted === undefined) {
            throw new Error(`the scope did not run`);
        }
        expect(minted.initialLoading.value).toBe(true);

        rejectList(new Error(`failed`));
        await settled();

        expect(minted.initialLoading.value).toBe(false);
        expect(minted.notice.value?.tone).toBe(`danger`);
        scope.stop();
    });

    it(`resets initial loading when the owner changes`, async () => {
        const owner = ref(`user-1`);
        let finishList: (tokens: readonly string[]) => void = () => {};
        const source: TokenSource<string, never, string> = {
            ...refusing,
            owner: () => owner.value,
            list: () => new Promise((resolve) => {
                finishList = resolve;
            }),
        };
        const scope = effectScope();
        const minted = scope.run(() => useMintedTokens(source));
        if (minted === undefined) {
            throw new Error(`the scope did not run`);
        }
        expect(minted.initialLoading.value).toBe(true);
        finishList([`token-1`]);
        await settled();
        expect(minted.initialLoading.value).toBe(false);

        owner.value = `user-2`;
        await settled();
        expect(minted.initialLoading.value).toBe(true);
        scope.stop();
    });
});
