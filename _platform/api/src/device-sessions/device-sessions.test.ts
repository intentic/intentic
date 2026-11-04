import { ACCOUNT_CHANGED, ACCOUNT_HEADER, MAX_DEVICE_ACCOUNTS } from "@intentic/api-contract";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP, multiSession } from "better-auth/plugins";
import { pino } from "pino";
import { z } from "zod";
import { createApp } from "../app.js";
import { createAuth } from "../auth.js";
import { configSchema } from "../config.js";
import { deviceSessions, expectationRefusal, fencedAuthPath } from "./device-sessions.js";
import { testIngressConfig } from "../testing.js";

// Several accounts in one browser, against a real Better Auth: the multi-session plugin as auth.ts mounts it, beside
// device-sessions.ts, on the memory adapter, signed in by emailed code, driven through its own handler as a browser
// would (cookies kept, an Origin on every call). Only the database is stood in for.

const ORIGIN = `http://localhost:6480`;
const BASE = `${ORIGIN}/api/auth`;

const testAuth = () => {
    const codes = new Map<string, string>();
    const auth = betterAuth({
        secret: `device-sessions-test-secret-0123456789abcdef`,
        baseURL: ORIGIN,
        basePath: `/api/auth`,
        database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
        emailAndPassword: { enabled: false },
        user: { deleteUser: { enabled: true } },
        plugins: [
            emailOTP({
                sendVerificationOTP: async ({ email, otp }) => {
                    codes.set(email, otp);
                },
            }),
            multiSession({ maximumSessions: MAX_DEVICE_ACCOUNTS }),
            deviceSessions({ maximumSessions: MAX_DEVICE_ACCOUNTS }),
        ],
    });
    return { auth, codes };
};

type TestAuth = ReturnType<typeof testAuth>;

interface Answer {
    readonly status: number;
    readonly body: unknown;
}

// The fields of Better Auth's answers these specs read.
const SignedInSchema = z.object({ user: z.object({ id: z.string() }) });
const SessionAnswerSchema = z.object({
    session: z.object({ token: z.string() }),
    user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
});
type SessionAnswer = z.infer<typeof SessionAnswerSchema>;

// One browser: its cookie jar, and the calls a page makes from it.
const browser = ({ auth, codes }: TestAuth) => {
    const jar = new Map<string, string>();
    const keep = (response: Response): void => {
        for (const line of response.headers.getSetCookie()) {
            const [pair = ``, ...attributes] = line.split(`;`).map((part) => part.trim());
            const at = pair.indexOf(`=`);
            const name = pair.slice(0, at);
            const value = pair.slice(at + 1);
            const gone = value === `` || attributes.some((attribute) => /^max-age=(0|-\d+)$/iu.test(attribute));
            if (gone) {
                jar.delete(name);
            } else {
                jar.set(name, value);
            }
        }
    };
    const call = async (method: `GET` | `POST`, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Answer> => {
        const headers = new Headers({ origin: ORIGIN, ...extra });
        if (jar.size > 0) {
            headers.set(`cookie`, [...jar].map(([name, value]) => `${name}=${value}`).join(`; `));
        }
        if (body !== undefined) {
            headers.set(`content-type`, `application/json`);
        }
        const response = await auth.handler(new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
        keep(response);
        const text = await response.text();
        return { status: response.status, body: text === `` ? null : JSON.parse(text) };
    };
    const signIn = async (email: string): Promise<string> => {
        expect((await call(`POST`, `/email-otp/send-verification-otp`, { email, type: `sign-in` })).status).toBe(200);
        const answer = await call(`POST`, `/sign-in/email-otp`, { email, otp: codes.get(email) });
        expect(answer.status).toBe(200);
        return SignedInSchema.parse(answer.body).user.id;
    };
    const session = async (): Promise<SessionAnswer | null> => SessionAnswerSchema.nullable().parse((await call(`GET`, `/get-session`)).body);
    const listed = async (): Promise<readonly SessionAnswer[]> => z.array(SessionAnswerSchema).parse((await call(`GET`, `/multi-session/list-device-sessions`)).body);
    const listedEmails = async (): Promise<readonly string[]> => (await listed()).map((entry) => entry.user.email).toSorted();
    const multiCookies = (): readonly string[] => [...jar.keys()].filter((name) => name.includes(`_multi-`));
    return { call, signIn, session, listed, listedEmails, multiCookies, jar };
};

describe(`several accounts in one browser`, () => {
    it(`lists every account signed in, and switches the active one`, async () => {
        const page = browser(testAuth());
        const work = await page.signIn(`artur@company.test`);
        await page.signIn(`radarsu@personal.test`);

        expect(await page.listedEmails()).toEqual([`artur@company.test`, `radarsu@personal.test`]);
        expect((await page.session())?.user.email).toBe(`radarsu@personal.test`);

        const company = (await page.listed()).find((entry) => entry.user.email === `artur@company.test`);
        expect((await page.call(`POST`, `/multi-session/set-active`, { sessionToken: company?.session.token })).status).toBe(200);
        expect((await page.session())?.user.id).toBe(work);
    });

    it(`adopts a session from before multi-session at its next check, so adding an account keeps it`, async () => {
        const page = browser(testAuth());
        await page.signIn(`artur@company.test`);
        // A browser signed in before the plugin holds only the active cookie.
        for (const name of page.multiCookies()) {
            page.jar.delete(name);
        }
        expect(await page.listedEmails()).toEqual([]);

        expect((await page.session())?.user.email).toBe(`artur@company.test`);
        expect(page.multiCookies()).toHaveLength(1);
        await page.signIn(`radarsu@personal.test`);

        expect(await page.listedEmails()).toEqual([`artur@company.test`, `radarsu@personal.test`]);
    });

    it(`would lose that session to the next sign-in without the check, which is why it adopts`, async () => {
        const page = browser(testAuth());
        await page.signIn(`artur@company.test`);
        for (const name of page.multiCookies()) {
            page.jar.delete(name);
        }

        await page.signIn(`radarsu@personal.test`);

        expect(await page.listedEmails()).toEqual([`radarsu@personal.test`]);
    });

    it(`adopts through the server's own session check too, the one every /rpc call makes`, async () => {
        const instance = testAuth();
        const page = browser(instance);
        await page.signIn(`artur@company.test`);
        for (const name of page.multiCookies()) {
            page.jar.delete(name);
        }
        const cookie = [...page.jar].map(([name, value]) => `${name}=${value}`).join(`; `);

        // As buildOrpcContext asks (context.ts); app.ts hands these cookies on with the /rpc answer.
        const { headers } = await instance.auth.api.getSession({ headers: new Headers({ cookie }), returnHeaders: true });

        expect(headers.getSetCookie().some((line) => line.includes(`_multi-`))).toBe(true);
    });

    it(`adopts nothing twice, and nothing for a browser with no session`, async () => {
        const page = browser(testAuth());
        expect(await page.session()).toBeNull();
        expect(page.multiCookies()).toEqual([]);

        await page.signIn(`artur@company.test`);
        const before = page.multiCookies();
        await page.session();
        await page.session();

        expect(page.multiCookies()).toEqual(before);
    });

    it(`revoking the account in use continues as the other one`, async () => {
        const page = browser(testAuth());
        const work = await page.signIn(`artur@company.test`);
        const personal = await page.signIn(`radarsu@personal.test`);
        const current = await page.session();

        const revoked = await page.call(`POST`, `/multi-session/revoke`, { sessionToken: current?.session.token }, { [ACCOUNT_HEADER]: personal });

        expect(revoked.status).toBe(200);
        expect((await page.session())?.user.id).toBe(work);
        expect(await page.listedEmails()).toEqual([`artur@company.test`]);
    });

    it(`signing out ends every account in the browser`, async () => {
        const page = browser(testAuth());
        await page.signIn(`artur@company.test`);
        await page.signIn(`radarsu@personal.test`);

        expect((await page.call(`POST`, `/sign-out`, {})).status).toBe(200);

        expect(await page.session()).toBeNull();
        expect(await page.listedEmails()).toEqual([]);
    });

    it(`lists no more than ${MAX_DEVICE_ACCOUNTS} accounts, and adopts none past them`, async () => {
        const page = browser(testAuth());
        for (const index of [1, 2, 3, 4, 5, 6]) {
            await page.signIn(`person${index}@many.test`);
        }

        // The sixth is signed in and active, but listed nowhere: the editor stops offering "Add another account" at the limit.
        expect((await page.session())?.user.email).toBe(`person6@many.test`);
        expect(await page.listedEmails()).toHaveLength(MAX_DEVICE_ACCOUNTS);
        expect(await page.listedEmails()).not.toContain(`person6@many.test`);
    });
});

describe(`a call meant for another account`, () => {
    it(`is refused before update-user runs, and the account keeps its name`, async () => {
        const page = browser(testAuth());
        const work = await page.signIn(`artur@company.test`);
        const personal = await page.signIn(`radarsu@personal.test`);
        const name = (await page.session())?.user.name;

        // A tab still drawn as the company account, on a cookie another tab switched to the personal one.
        const refused = await page.call(`POST`, `/update-user`, { name: `Renamed` }, { [ACCOUNT_HEADER]: work });

        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: ACCOUNT_CHANGED });
        expect((await page.session())?.user).toMatchObject({ id: personal, name });
    });

    it(`passes when it names the account the session is`, async () => {
        const page = browser(testAuth());
        const personal = await page.signIn(`radarsu@personal.test`);

        const renamed = await page.call(`POST`, `/update-user`, { name: `Artur` }, { [ACCOUNT_HEADER]: personal });

        expect(renamed.status).toBe(200);
        expect((await page.session())?.user.name).toBe(`Artur`);
    });

    it(`never deletes the account the browser switched to`, async () => {
        const page = browser(testAuth());
        const work = await page.signIn(`artur@company.test`);
        const personal = await page.signIn(`radarsu@personal.test`);

        const refused = await page.call(`POST`, `/delete-user`, {}, { [ACCOUNT_HEADER]: work });

        expect(refused.status).toBe(409);
        expect((await page.session())?.user.id).toBe(personal);
        expect(await page.listedEmails()).toEqual([`artur@company.test`, `radarsu@personal.test`]);
    });

    it(`is refused when the browser is signed in as nobody`, async () => {
        const page = browser(testAuth());
        const work = await page.signIn(`artur@company.test`);
        await page.call(`POST`, `/sign-out`, {});

        expect((await page.call(`POST`, `/update-user`, { name: `Renamed` }, { [ACCOUNT_HEADER]: work })).status).toBe(409);
    });

    it(`leaves a call with no account named as it always was`, async () => {
        const page = browser(testAuth());
        await page.signIn(`radarsu@personal.test`);

        expect((await page.call(`POST`, `/update-user`, { name: `Artur` })).status).toBe(200);
    });

    it(`does not hold the switch itself, or a sign-in, to the account the page was drawn for`, async () => {
        const page = browser(testAuth());
        const work = await page.signIn(`artur@company.test`);
        await page.signIn(`radarsu@personal.test`);
        const company = (await page.listed()).find((entry) => entry.user.email === `artur@company.test`);

        // The personal tab asks to switch back: it names itself, and the switch is the point.
        const personal = (await page.session())?.user.id ?? ``;
        expect((await page.call(`POST`, `/multi-session/set-active`, { sessionToken: company?.session.token }, { [ACCOUNT_HEADER]: personal })).status).toBe(200);
        expect((await page.call(`GET`, `/get-session`, undefined, { [ACCOUNT_HEADER]: personal })).status).toBe(200);
        expect((await page.session())?.user.id).toBe(work);
    });

    it(`refuses a header that names no account`, async () => {
        const page = browser(testAuth());
        await page.signIn(`radarsu@personal.test`);

        expect((await page.call(`POST`, `/update-user`, { name: `Artur` }, { [ACCOUNT_HEADER]: `not an id;` })).status).toBe(400);
    });
});

describe(`which auth routes are held to the account`, () => {
    it.each([`/update-user`, `/delete-user`, `/sign-out`, `/link-social`, `/unlink-account`, `/revoke-session`, `/multi-session/revoke`, `/list-accounts`])(
        `holds %s`,
        (path) => {
            expect(fencedAuthPath(path)).toBe(true);
        },
    );

    it.each([
        `/get-session`,
        `/sign-in/social`,
        `/sign-in/email-otp`,
        `/callback/google`,
        `/one-tap/callback`,
        `/email-otp/send-verification-otp`,
        `/one-time-token/verify`,
        `/multi-session/list-device-sessions`,
        `/multi-session/set-active`,
    ])(`leaves %s`, (path) => {
        expect(fencedAuthPath(path)).toBe(false);
    });

    it(`answers the same account with nothing, another or nobody with 409, and a malformed id with 400`, () => {
        expect(expectationRefusal(`user_1`, `user_1`)).toBeUndefined();
        expect(expectationRefusal(`user_1`, `user_2`)?.status).toBe(409);
        expect(expectationRefusal(`user_1`, undefined)?.status).toBe(409);
        expect(expectationRefusal(`a b`, `a b`)?.status).toBe(400);
    });
});

/* THE SAME RULE ON /rpc: every answer says whose it is, and a call meant for another account never reaches a handler. */

const config = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev`, reapDryRun: `true` },
    ingress: testIngressConfig,
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});
const logger = pino({ level: `silent` });

describe(`/rpc and the account a page is drawn for`, () => {
    // The app with the session check answering as `userId` (or nobody), and the one table GET /rpc/me reads.
    const signedInApp = (userId: string | undefined) => {
        const count = jest.fn(async () => 0);
        // SAFETY: GET /rpc/me reads one table, `account.count` (sign-in.ts `hasGoogleAccount`), and these specs reach no other route.
        const { app, auth } = createApp(config, { account: { count } } as never, logger);
        const user = { id: userId, email: `artur@company.test`, name: `Artur`, image: null, emailVerified: true, createdAt: new Date(0) };
        const answer = { response: userId === undefined ? null : { session: { token: `t`, userId }, user }, headers: new Headers() };
        // SAFETY: buildOrpcContext (context.ts) reads only `response.user` and `headers` off the session check.
        jest.spyOn(auth.api, `getSession`).mockImplementation((async () => answer) as never);
        return { app, count };
    };

    it(`says on every answer which account it answered as`, async () => {
        const { app } = signedInApp(`user_work`);

        const response = await app.request(`/rpc/me`, { headers: { origin: `https://app.test` } });

        expect(response.status).toBe(200);
        expect(response.headers.get(ACCOUNT_HEADER)).toBe(`user_work`);
        expect(response.headers.get(`access-control-expose-headers`)?.toLowerCase()).toContain(ACCOUNT_HEADER);
    });

    it(`refuses a call meant for another account before the handler runs, and names the account it is now`, async () => {
        const { app, count } = signedInApp(`user_personal`);

        const response = await app.request(`/rpc/me`, { headers: { [ACCOUNT_HEADER]: `user_work` } });

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ defined: false, code: ACCOUNT_CHANGED, status: 409 });
        expect(response.headers.get(ACCOUNT_HEADER)).toBe(`user_personal`);
        expect(count).not.toHaveBeenCalled();
    });

    it(`refuses a call meant for an account when the browser is signed in as nobody`, async () => {
        const { app, count } = signedInApp(undefined);

        const response = await app.request(`/rpc/me`, { headers: { [ACCOUNT_HEADER]: `user_work` } });

        expect(response.status).toBe(409);
        expect(response.headers.get(ACCOUNT_HEADER)).toBeNull();
        expect(count).not.toHaveBeenCalled();
    });

    it(`runs a call meant for the session's own account, and one that names nobody, as before`, async () => {
        const { app, count } = signedInApp(`user_work`);

        expect((await app.request(`/rpc/me`, { headers: { [ACCOUNT_HEADER]: `user_work` } })).status).toBe(200);
        expect((await app.request(`/rpc/me`)).status).toBe(200);
        expect(count).toHaveBeenCalledTimes(2);
    });

    it(`says nothing of an account to a browser signed in as nobody`, async () => {
        const { app } = signedInApp(undefined);

        const response = await app.request(`/rpc/me`);

        expect(response.status).toBe(200);
        expect(response.headers.get(ACCOUNT_HEADER)).toBeNull();
    });
});

describe(`auth.ts`, () => {
    it(`mounts multi-session and the device-sessions plugin`, () => {
        // SAFETY: building Better Auth only hands the client to its adapter, which nothing here calls.
        const ids = createAuth(config, {} as never, logger).options.plugins.map((plugin) => plugin.id);
        expect(ids).toEqual(expect.arrayContaining([`multi-session`, `intentic-device-sessions`]));
    });
});
