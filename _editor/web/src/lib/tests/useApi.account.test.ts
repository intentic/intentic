import { ACCOUNT_HEADER } from "@intentic/api-contract";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { resetAccountPartitionForTests } from "../../app/storage/browserStorage";
import { AccountChangedError, enterAccount, resetAccountBoundaryForTests, setAccountReconciler } from "../accounts/accountBoundary";
import { apiClient } from "../useApi";

// The platform client as the account boundary shapes it (useApi.ts): a call that changes something names the account the
// page is drawn for, and an answer made as another account never reaches the caller. The network is a stand-in; the
// client, the contract and the boundary are the real ones.

const ADA = { id: `acc-a`, email: `ada@example.com` };

const fetched = jest.fn<(request: Request, init?: RequestInit) => Promise<Response>>();

type AnswerBody = Readonly<Record<string, string | boolean | null>>;

// The platform's answer, made as `account`, with `body` as its JSON.
const answerAs = (account: string, body: AnswerBody): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": `application/json`, [ACCOUNT_HEADER]: account } });

// The request the client last handed the network.
const sent = (): Request | undefined => fetched.mock.calls.at(-1)?.[0];

beforeEach(() => {
    fetched.mockReset();
    stubGlobal(`fetch`, fetched);
});

afterEach(() => {
    unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    resetAccountPartitionForTests();
    resetAccountBoundaryForTests();
});

it(`names the page's account on a call that changes something`, async () => {
    enterAccount(ADA);
    fetched.mockResolvedValue(answerAs(ADA.id, { ok: true }));

    expect(await apiClient.sandbox.wake({ sandboxId: `sbx-1` })).toEqual({ ok: true });

    expect([sent()?.method, sent()?.headers.get(ACCOUNT_HEADER)]).toEqual([`POST`, ADA.id]);
});

it(`names no account on a read`, async () => {
    enterAccount(ADA);
    fetched.mockResolvedValue(answerAs(ADA.id, { id: ADA.id, email: ADA.email, name: `Ada`, image: null }));

    expect(await apiClient.me.get()).toMatchObject({ id: ADA.id });

    expect([sent()?.method, sent()?.headers.get(ACCOUNT_HEADER)]).toEqual([`GET`, null]);
});

it(`never hands the caller an answer made as another account, and asks who is signed in now`, async () => {
    const reconcile = jest.fn(async () => undefined);
    setAccountReconciler(reconcile);
    enterAccount(ADA);
    fetched.mockResolvedValue(answerAs(`acc-b`, { id: `acc-b`, email: `bea@example.com`, name: `Bea`, image: null }));

    await expect(apiClient.me.get()).rejects.toBeInstanceOf(AccountChangedError);

    expect(reconcile).toHaveBeenCalledTimes(1);
});
