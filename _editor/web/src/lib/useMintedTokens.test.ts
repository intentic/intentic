import { effectScope, type EffectScope } from "vue";
import { type TokenSource, useMintedTokens } from "./useMintedTokens";

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
});
