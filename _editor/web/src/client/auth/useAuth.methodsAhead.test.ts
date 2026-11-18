import type { User } from "@intentic/api-contract";
import { ref } from "vue";

// The account's ways in asked beside the session check rather than after it: /me goes out with the check when this
// browser is signed in as someone (its account pointer), as a read `ahead` of the check, and its answer counts only for
// the account the check then names. With nobody's pointer, or an early answer that cannot be used, /me is asked after
// the check, as it always was. The platform client is stubbed at the seam.

type ClientAnswer = { data?: unknown; error?: { status?: number; code?: string; message?: string } | null };
const getSession = jest.fn<() => Promise<ClientAnswer>>();
jest.mock(`better-auth/client`, () => ({ createAuthClient: () => ({ getSession: () => getSession() }) }));
const meGet = jest.fn<(input?: undefined, options?: { context?: { ahead?: boolean } }) => Promise<User | null>>();
jest.mock(`../../lib/useApi`, () => ({
    apiClient: { me: { get: (input?: undefined, options?: { context?: { ahead?: boolean } }) => meGet(input, options) } },
}));
jest.mock(`../session/sandboxSession`, () => ({ useSandboxSession: () => ({ clearSessions: jest.fn(), retireAccountAccess: jest.fn() }) }));
jest.mock(`./useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ clearCredential: jest.fn() }) }));
jest.mock(`../../lib/queryPersistence`, () => ({ clearPersistedQueries: jest.fn(async () => undefined) }));
jest.mock(`../../app/environments/local`, () => ({ localFace: () => undefined }));
jest.mock(`../../app/environments/desktop`, () => ({ announceDesktopRoster: jest.fn(), desktopVersion: () => undefined }));
jest.mock(`../directory/deviceDirectory`, () => ({ forgetAccount: jest.fn() }));
jest.mock(`../directory/directState`, () => ({ directMode: ref(false) }));
jest.mock(`@intentic/ui/skeleton-store`, () => ({ clearImprints: jest.fn(async () => undefined) }));

const { useAuth } = await import(`./useAuth`);
const { accountWaysIn } = await import(`./signInMethods`);
const { invalidatePlatformAuth } = await import(`../../lib/authLifecycle`);
const { openAccountPartition } = await import(`../../app/storage/browserStorage`);

const SESSION_USER = { id: `u-1`, email: `ana@corp.example`, name: `Ana`, image: null };
const AHEAD = { context: { ahead: true } };

const sessionAnswer = (): ClientAnswer => ({ data: { user: SESSION_USER, session: { token: `session-token` } }, error: null });

// A session check this test answers by hand, so what was asked while it was still out can be read.
const heldSessionCheck = (): ((answer: ClientAnswer) => void) => {
    let answer!: (value: ClientAnswer) => void;
    getSession.mockReturnValueOnce(
        new Promise<ClientAnswer>((resolve) => {
            answer = resolve;
        }),
    );
    return (value) => answer(value);
};

beforeEach(async () => {
    getSession.mockReset().mockResolvedValue(sessionAnswer());
    meGet.mockReset().mockResolvedValue({ ...SESSION_USER, signInMethods: [`email`] });
    // Each case starts signed out, with nothing remembered of the last account's ways in.
    await invalidatePlatformAuth(false);
});

describe(`with this browser signed in as someone`, () => {
    beforeEach(() => {
        openAccountPartition(SESSION_USER.id);
    });

    it(`asks /me while the session check is still out, once, and holds the account with its ways in`, async () => {
        const answerSession = heldSessionCheck();
        const refreshed = useAuth().refresh();

        expect(meGet).toHaveBeenCalledTimes(1);
        expect(meGet).toHaveBeenCalledWith(undefined, AHEAD);

        answerSession(sessionAnswer());
        await refreshed;
        expect(meGet).toHaveBeenCalledTimes(1);
        expect(accountWaysIn.value).toEqual({ email: SESSION_USER.email, methods: [`email`] });
    });

    it(`asks again after the check when the early answer is another account's`, async () => {
        meGet.mockResolvedValueOnce({ id: `u-2`, email: `bo@corp.example`, name: `Bo`, image: null, signInMethods: [`google`] });

        await useAuth().refresh();

        expect(meGet).toHaveBeenCalledTimes(2);
        expect(meGet).toHaveBeenLastCalledWith(undefined, undefined);
        expect(accountWaysIn.value).toEqual({ email: SESSION_USER.email, methods: [`email`] });
    });

    // As a failed ask after the check: the account reads as a Google one, and the next check asks again.
    it(`takes a failed early ask as the ask failing, and asks again at the next check`, async () => {
        meGet.mockRejectedValueOnce(new Error(`platform down`));

        await useAuth().refresh();
        expect(meGet).toHaveBeenCalledTimes(1);
        expect(accountWaysIn.value).toEqual({ email: SESSION_USER.email, methods: undefined });

        await useAuth().refresh();
        expect(meGet).toHaveBeenCalledTimes(2);
        expect(accountWaysIn.value).toEqual({ email: SESSION_USER.email, methods: [`email`] });
    });

    // A session that ended while the browser was away: the early ask was refused, and the check says there is nobody.
    it(`holds nobody when the check finds no session, whatever the early ask met`, async () => {
        getSession.mockResolvedValue({ data: null, error: null });
        meGet.mockRejectedValueOnce(Object.assign(new Error(`Unauthorized`), { status: 401 }));

        expect(await useAuth().refresh()).toBeNull();
        expect(meGet).toHaveBeenCalledTimes(1);
        expect(accountWaysIn.value).toBeUndefined();
    });

    it(`does not ask ahead once the account's ways in are known`, async () => {
        await useAuth().refresh();
        await useAuth().refresh();

        expect(meGet).toHaveBeenCalledTimes(1);
    });
});

describe(`with nobody signed in on this browser`, () => {
    beforeEach(() => {
        openAccountPartition(undefined);
    });

    it(`asks /me only once the session check has named the account`, async () => {
        const answerSession = heldSessionCheck();
        const refreshed = useAuth().refresh();

        expect(meGet).not.toHaveBeenCalled();

        answerSession(sessionAnswer());
        await refreshed;
        expect(meGet).toHaveBeenCalledTimes(1);
        expect(meGet).toHaveBeenCalledWith(undefined, undefined);
    });
});
