import type { User } from "@intentic/api-contract";
import { ref } from "vue";

// The emailed-code sign-in as useAuth.ts drives the platform's client, and how the account's ways in are learned: from
// /me, once per account, since the session's own answer does not carry them. The platform client is stubbed at the
// seam; the code's refusals and the account the window holds afterwards are the real ones.

type ClientAnswer = { data?: unknown; error?: { status?: number; code?: string; message?: string } | null };
const sendVerificationOtp = jest.fn<(input: { email: string; type: string }) => Promise<ClientAnswer>>();
const signInEmailOtp = jest.fn<(input: { email: string; otp: string }) => Promise<ClientAnswer>>();
const linkSocial = jest.fn<(input: { provider: string; callbackURL: string }) => Promise<ClientAnswer>>();
const getSession = jest.fn<() => Promise<ClientAnswer>>();
jest.mock(`better-auth/client`, () => ({
    createAuthClient: () => ({
        getSession: () => getSession(),
        emailOtp: { sendVerificationOtp: (input: { email: string; type: string }) => sendVerificationOtp(input) },
        signIn: { emailOtp: (input: { email: string; otp: string }) => signInEmailOtp(input) },
        linkSocial: (input: { provider: string; callbackURL: string }) => linkSocial(input),
    }),
}));
const meGet = jest.fn<() => Promise<User | null>>();
jest.mock(`../../lib/useApi`, () => ({ apiClient: { me: { get: () => meGet() } } }));
jest.mock(`../session/sandboxSession`, () => ({ useSandboxSession: () => ({ clearSessions: jest.fn(), retireAccountAccess: jest.fn() }) }));
jest.mock(`./useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ clearCredential: jest.fn() }) }));
jest.mock(`../../lib/queryPersistence`, () => ({ clearPersistedQueries: jest.fn(async () => undefined) }));
jest.mock(`../../app/environments/local`, () => ({ localFace: () => undefined }));
jest.mock(`../../app/environments/desktop`, () => ({ announceDesktopRoster: jest.fn() }));
jest.mock(`../directory/deviceDirectory`, () => ({ forgetAccount: jest.fn() }));
jest.mock(`../directory/directState`, () => ({ directMode: ref(false) }));
jest.mock(`@intentic/ui/skeleton-store`, () => ({ clearImprints: jest.fn(async () => undefined) }));

const { useAuth } = await import(`./useAuth`);
const { accountWaysIn } = await import(`./signInMethods`);
const { EmailCodeError } = await import(`./emailCode`);
const { invalidatePlatformAuth } = await import(`../../lib/authLifecycle`);

const SESSION_USER = { id: `u-1`, email: `ana@corp.example`, name: `Ana`, image: null };

beforeEach(async () => {
    sendVerificationOtp.mockReset().mockResolvedValue({ data: { success: true }, error: null });
    signInEmailOtp.mockReset().mockResolvedValue({ data: {}, error: null });
    linkSocial.mockReset().mockResolvedValue({ data: {}, error: null });
    getSession.mockReset().mockResolvedValue({ data: { user: SESSION_USER }, error: null });
    meGet.mockReset().mockResolvedValue({ ...SESSION_USER, signInMethods: [`email`] });
    // Each case starts signed out, with nothing remembered of the last account's ways in.
    await invalidatePlatformAuth(false);
});

it(`asks for a sign-in code for the address as typed, trimmed`, async () => {
    await useAuth().sendEmailCode(`  ana@corp.example `);

    expect(sendVerificationOtp).toHaveBeenCalledWith({ email: `ana@corp.example`, type: `sign-in` });
});

it(`says the platform's rate limit as a wait, by name`, async () => {
    sendVerificationOtp.mockResolvedValue({ error: { status: 429, message: `Too many requests` } });

    const refused = await useAuth()
        .sendEmailCode(`ana@corp.example`)
        .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(EmailCodeError);
    expect(refused).toMatchObject({ refusal: `rate-limited` });
});

it(`signs in with the code and holds the account with its ways in, for the session module too`, async () => {
    await useAuth().signInWithEmailCode(`ana@corp.example`, `123456`);

    expect(signInEmailOtp).toHaveBeenCalledWith({ email: `ana@corp.example`, otp: `123456` });
    expect(useAuth().user.value).toEqual({ ...SESSION_USER, signInMethods: [`email`] });
    expect(accountWaysIn.value).toEqual({ email: `ana@corp.example`, methods: [`email`] });
});

it(`names a wrong code, and holds no account for it`, async () => {
    signInEmailOtp.mockResolvedValue({ error: { status: 400, code: `INVALID_OTP`, message: `Invalid OTP` } });

    await expect(useAuth().signInWithEmailCode(`ana@corp.example`, `000000`)).rejects.toMatchObject({ refusal: `invalid` });
    expect(useAuth().user.value).toBeNull();
});

it(`asks /me once per account, not on every session check`, async () => {
    await useAuth().refresh();
    await useAuth().refresh();

    expect(meGet).toHaveBeenCalledTimes(1);
});

// A platform from before email sign-in, or one /me could not be asked of: the account reads as a Google one, as every
// account was, and a failed ask is asked again at the next check rather than kept.
it(`reads an account /me could not describe as a Google one, and asks again next time`, async () => {
    meGet.mockRejectedValueOnce(new Error(`platform down`));

    await useAuth().refresh();
    expect(useAuth().user.value).toEqual(SESSION_USER);
    expect(accountWaysIn.value).toEqual({ email: `ana@corp.example`, methods: undefined });

    await useAuth().refresh();
    expect(accountWaysIn.value).toEqual({ email: `ana@corp.example`, methods: [`email`] });
});

it(`links Google to the account signed in now, returning to the page asked for`, async () => {
    await useAuth().linkGoogle(`/settings`);

    expect(linkSocial).toHaveBeenCalledWith({ provider: `google`, callbackURL: `${globalThis.location.origin}/settings` });
});
