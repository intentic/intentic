import type { SandboxSummary } from "@intentic/api-contract";
import { stubGlobal, mocked } from "@intentic/testing/bun";

// The sandbox list asked beside the session check (main.ts): the moment the page enters an account, the early answer is
// the list's own fetch, which the reads after it join; it is that answer only when made as the account entered, and
// otherwise the platform asked again as that account. A page that enters nobody leaves the answer unread.

stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
type ListOptions = { context?: { ahead?: boolean; answeredAs?: (account: string | null) => void } };
jest.mock("../../../lib/useApi", () => ({ apiClient: { sandbox: { list: jest.fn() } } }));
const { apiClient } = await import("../../../lib/useApi");
const listMock = mocked(apiClient.sandbox.list);
const { queryClient } = await import("../../../lib/queryPersistence");
const { askListAhead, useSandbox } = await import("../useSandbox");
const { enterAccount, resetAccountBoundaryForTests } = await import("../../../lib/accounts/accountBoundary");

const summary = (id: string): SandboxSummary => ({
    id,
    name: id,
    image: null,
    daemonUrl: null,
    lastSeenAt: `2026-11-18T00:00:00.000Z`,
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    hosted: null,
    token: `token-${id}`,
    tier: `owner`,
    providedAddress: false,
    localHostname: null,
});

const ANA = { id: `u-ana`, email: `ana@corp.example` };

// The platform's answer to a list read: these rows, made as `account` (its ACCOUNT_HEADER).
const answersAs = (account: string | null, ...ids: string[]) => async (_input?: unknown, options?: ListOptions) => {
    options?.context?.answeredAs?.(account);
    return { sandboxes: ids.map(summary) };
};

const ids = (rows: readonly SandboxSummary[]): string[] => rows.map((row) => row.id);

beforeEach(() => {
    queryClient.clear();
    jest.resetAllMocks();
    resetAccountBoundaryForTests();
});

it(`asks the list as a read ahead of the session check, and the reads once an account is entered join it`, async () => {
    listMock.mockImplementationOnce(answersAs(ANA.id, `early`));
    askListAhead();
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls[0]?.[1]).toEqual({ context: { ahead: true, answeredAs: expect.any(Function) } });

    enterAccount(ANA);
    // The liveness loop's forced refresh and the shell gate's read, both asked once the account is entered.
    const [refreshed, read] = await Promise.all([useSandbox().refresh(), useSandbox().list()]);

    expect(ids(refreshed)).toEqual([`early`]);
    expect(ids(read)).toEqual([`early`]);
    expect(listMock).toHaveBeenCalledTimes(1);
});

it(`asks again as the entered account when the early answer was made as another`, async () => {
    listMock.mockImplementationOnce(answersAs(`u-bo`, `bos`)).mockImplementationOnce(answersAs(ANA.id, `anas`));
    askListAhead();
    enterAccount(ANA);

    expect(ids(await useSandbox().list())).toEqual([`anas`]);
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock.mock.calls[1]?.[1]).toBeUndefined();
});

it(`asks again when the early answer names nobody`, async () => {
    listMock.mockImplementationOnce(answersAs(null, `nobodys`)).mockImplementationOnce(answersAs(ANA.id, `anas`));
    askListAhead();
    enterAccount(ANA);

    expect(ids(await useSandbox().list())).toEqual([`anas`]);
});

it(`asks again when the early ask failed`, async () => {
    listMock.mockRejectedValueOnce(new Error(`401`)).mockImplementationOnce(answersAs(ANA.id, `anas`));
    askListAhead();
    enterAccount(ANA);

    expect(ids(await useSandbox().list())).toEqual([`anas`]);
    expect(listMock).toHaveBeenCalledTimes(2);
});

it(`leaves the early answer unread while no account is entered`, async () => {
    listMock.mockImplementationOnce(answersAs(ANA.id, `early`));
    askListAhead();
    await Promise.resolve();

    expect(queryClient.getQueryState([`sandbox`, `list`])).toBeUndefined();
});

it(`leaves it unread when the account is entered past the session check's budget`, async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, `now`).mockReturnValue(now);
    listMock.mockImplementationOnce(answersAs(ANA.id, `early`)).mockImplementationOnce(answersAs(ANA.id, `later`));
    askListAhead();
    clock.mockReturnValue(now + 10_001);
    enterAccount(ANA);

    expect(queryClient.getQueryState([`sandbox`, `list`])).toBeUndefined();
    expect(ids(await useSandbox().list())).toEqual([`later`]);
    clock.mockRestore();
});
