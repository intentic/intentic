import { generateKeyPairSync } from "node:crypto";
import { mintIdentityAssertion, verifyIdentityAssertion } from "@intentic/sandbox-contract/identity-assertion";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { pino } from "pino";
import { z } from "zod";
import { emailCodes } from "./auth.js";
import { configSchema, type Config } from "./config.js";
import { memoryAllowances } from "./testing.js";
import {
    emailSignInEnabled,
    identityKeyOf,
    identitySigningKeyOf,
    maySendSignInCode,
    SEND_CODE_PATH,
    sendSignInCode,
    signInCodeLink,
    signInMethodsOf,
    signInOptionsOf,
    takeCodeAllowance,
} from "./sign-in.js";

const logger = pino({ level: `silent` });

const configWith = (
    over: { email?: { apiKey: string; from: string }; signIn?: { email: string }; canaryEmail?: string; signingKey?: string; webOrigin?: string } = {},
): Config =>
    configSchema.parse({
        database: { url: `postgres://x` },
        betterAuth: { secret: `s` },
        webOrigin: over.webOrigin ?? `https://app.test`,
        google: { clientId: `cid`, clientSecret: `cs` },
        email: over.email ?? { apiKey: `re_key`, from: `intentic <hi@intentic.test>` },
        signIn: over.signIn ?? { email: `true` },
        hosted: { canaryEmail: over.canaryEmail ?? `` },
        identity: { signingKey: over.signingKey ?? `` },
        log: { level: `silent`, pretty: `false` },
    });

const at = (ms: number): Date => new Date(1_800_000_000_000 + ms);

// What Resend is asked to send, read back off the request the platform made.
const SentMailSchema = z.object({ from: z.string(), to: z.string(), subject: z.string(), html: z.string() });

describe(`email sign-in`, () => {
    it(`is offered wherever a code can be mailed, and in development where the log shows it; never in production without mail`, () => {
        expect(emailSignInEnabled(configWith(), { NODE_ENV: `production` })).toBe(true);
        expect(emailSignInEnabled(configWith({ email: { apiKey: ``, from: `` } }), { NODE_ENV: `production` })).toBe(false);
        expect(emailSignInEnabled(configWith({ email: { apiKey: ``, from: `` } }), { NODE_ENV: `development` })).toBe(true);
        expect(emailSignInEnabled(configWith({ signIn: { email: `false` } }), { NODE_ENV: `production` })).toBe(false);
        expect(signInOptionsOf(configWith())).toEqual({ google: true, email: true });
    });

    it(`links to the confirm page with the address and the code, which the page spends only on a press`, () => {
        expect(signInCodeLink(configWith(), `ada+test@example.org`, `012345`)).toBe(`https://app.test/login/confirm?email=ada%2Btest%40example.org&code=012345`);
    });

    // A followed link lands where a typed code does: an invite, a desktop app's sign-in with its state and challenge.
    it(`carries on, in the link, to the page on this editor the code was asked from`, () => {
        expect(signInCodeLink(configWith(), `ada@example.org`, `012345`, `/invite/tok-1`)).toBe(
            `https://app.test/login/confirm?email=ada%40example.org&code=012345&returnTo=%2Finvite%2Ftok-1`,
        );
        const link = new URL(signInCodeLink(configWith(), `ada@example.org`, `012345`, `/desktop-auth?state=nonce&challenge=chal`));
        expect(link.searchParams.get(`returnTo`)).toBe(`/desktop-auth?state=nonce&challenge=chal`);
        expect(link.origin).toBe(`https://app.test`);
    });

    // The editor drops one too; the mail is never the place a foreign destination is written.
    it(`writes no destination off the editor's origin into the link, nor a protocol-relative one`, () => {
        for (const returnTo of [`https://evil.example/invite/tok-1`, `//evil.example`, `/\\evil.example`, `/\t/evil.example`, `javascript:alert(1)`, `/`]) {
            expect(signInCodeLink(configWith(), `ada@example.org`, `012345`, returnTo)).toBe(`https://app.test/login/confirm?email=ada%40example.org&code=012345`);
        }
    });

    it(`sends each address one code a minute and five an hour, whoever asks`, async () => {
        const allowances = memoryAllowances();
        expect(await takeCodeAllowance(allowances, `Ada@Example.org`, at(0))).toBe(true);
        expect(await takeCodeAllowance(allowances, `ada@example.org`, at(30_000))).toBe(false);
        expect(await takeCodeAllowance(allowances, `bo@example.org`, at(30_000))).toBe(true);
        expect(await takeCodeAllowance(allowances, `ada@example.org`, at(60_000))).toBe(true);
        expect(await takeCodeAllowance(allowances, `ada@example.org`, at(120_000))).toBe(true);
        expect(await takeCodeAllowance(allowances, `ada@example.org`, at(180_000))).toBe(true);
        expect(await takeCodeAllowance(allowances, `ada@example.org`, at(240_000))).toBe(true);
        expect(await takeCodeAllowance(allowances, `ada@example.org`, at(300_000))).toBe(false);
        expect(await takeCodeAllowance(allowances, `ada@example.org`, at(3_600_000))).toBe(true);
    });

    describe(`sendSignInCode`, () => {
        const mailed: Array<z.infer<typeof SentMailSchema>> = [];
        beforeEach(() => {
            mailed.length = 0;
            jest.spyOn(globalThis, `fetch`).mockImplementation(
                Object.assign(
                    async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
                        mailed.push(SentMailSchema.parse(JSON.parse(String(init?.body))));
                        return new Response(`{}`, { status: 200 });
                    },
                    { preconnect: globalThis.fetch.preconnect },
                ),
            );
        });
        afterEach(() => jest.restoreAllMocks());

        it(`mails the code and the confirm link to the address, the link escaped into the page`, async () => {
            await sendSignInCode({ config: configWith(), logger }, { email: `Ada@Example.org`, code: `012345` });
            expect(mailed).toEqual([{ from: `intentic <hi@intentic.test>`, to: `ada@example.org`, subject: `Your intentic sign-in code`, html: expect.stringContaining(`012345`) }]);
            expect(mailed[0]?.html).toContain(`https://app.test/login/confirm?email=ada%40example.org&amp;code=012345`);
        });

        // An invite's link that resolves only here would strand its recipient; a sign-in code's recipient is the person at
        // this machine, and the code works wherever the link does not.
        it(`mails the code even where the confirm link resolves only on this machine`, async () => {
            await sendSignInCode({ config: configWith({ webOrigin: `http://localhost:47145` }), logger }, { email: `ada@example.org`, code: `012345` });
            expect(mailed.map((mail) => mail.to)).toEqual([`ada@example.org`]);
            expect(mailed[0]?.html).toContain(`http://localhost:47145/login/confirm?email=ada%40example.org&amp;code=012345`);
        });

        it(`sends nothing to the canary's address, even if a send ever reached it past the gate`, async () => {
            const deps = { config: configWith({ canaryEmail: `Canary@Intentic.test` }), logger };
            await expect(sendSignInCode(deps, { email: `canary@intentic.test`, code: `111111` })).resolves.toBeUndefined();
            await sendSignInCode(deps, { email: `ada@example.org`, code: `222222` });
            expect(mailed.map((mail) => mail.to)).toEqual([`ada@example.org`]);
            expect(mailed[0]?.html).toContain(`222222`);
        });
    });

    it(`lets a code be minted once per allowance, never for the canary, and takes nothing for the canary`, async () => {
        const deps = { config: configWith({ canaryEmail: `Canary@Intentic.test` }), allowances: memoryAllowances(), logger };
        expect(await maySendSignInCode(deps, ` Canary@Intentic.test`)).toBe(false);
        expect(await maySendSignInCode(deps, `Ada@Example.org`)).toBe(true);
        expect(await maySendSignInCode(deps, `ada@example.org`)).toBe(false);
        // The canary's refusal spent none of its own allowance: it is refused for who it is, not for how often.
        expect(await takeCodeAllowance(deps.allowances, `canary@intentic.test`)).toBe(true);
    });

    it(`names Google for an account with a Google account linked, and email wherever codes are mailed`, () => {
        expect(signInMethodsOf(true, configWith())).toEqual([`google`, `email`]);
        expect(signInMethodsOf(false, configWith())).toEqual([`email`]);
        expect(signInMethodsOf(true, configWith({ signIn: { email: `false` } }))).toEqual([`google`]);
    });

    it(`answers announces with the identity key's public half`, () => {
        const pair = generateKeyPairSync(`ed25519`, { publicKeyEncoding: { type: `spki`, format: `pem` }, privateKeyEncoding: { type: `pkcs8`, format: `pem` } });
        expect(identityKeyOf(configWith({ signingKey: pair.privateKey }))).toBe(pair.publicKey);
        expect(identitySigningKeyOf(configWith({ signingKey: pair.privateKey }))).toBe(pair.privateKey);
    });

    // Production ran without IDENTITY_SIGNING_KEY (2026-10-26) and turned every invited email member away for good.
    it(`signs with a key derived from the session secret when none is configured: stable, and its own per secret`, () => {
        const derived = identitySigningKeyOf(configWith());
        const claim = { sandboxId: `0123456789ab`, email: `ada@example.org`, method: `email` as const, issuedAtMs: Date.now() };
        expect(verifyIdentityAssertion(identityKeyOf(configWith()), mintIdentityAssertion(derived, claim), Date.now())).toMatchObject({
            email: `ada@example.org`,
        });
        expect(identitySigningKeyOf(configWith())).toBe(derived);
        const other: Config = { ...configWith(), betterAuth: { secret: `another` } };
        expect(identitySigningKeyOf(other)).not.toBe(derived);
        expect(identityKeyOf(other)).not.toBe(identityKeyOf(configWith()));
    });
});

// The per-address allowance against a real Better Auth (its emailOTP plugin as auth.ts mounts it, on the memory
// adapter): Better Auth's send endpoint stores a new code before it asks for the mail, so the allowance is decided ahead
// of it. A send refused for the allowance must answer like a sent one, mail nothing, and leave the mailed code working.

const ORIGIN = `http://localhost:6480`;
const BASE = `${ORIGIN}/api/auth`;

const gateConfig = configSchema.parse({
    database: { url: `postgres://x` },
    betterAuth: { secret: `s` },
    webOrigin: `https://app.test`,
    google: { clientId: `cid`, clientSecret: `cs` },
    email: { apiKey: `re_key`, from: `intentic <hi@intentic.test>` },
    signIn: { email: `true` },
    hosted: { canaryEmail: `canary@intentic.test` },
    log: { level: `silent`, pretty: `false` },
});

// What Resend is asked to send, read back off the request the platform made.
const GateMailSchema = z.object({ to: z.string(), html: z.string() });
const mailed: Array<z.infer<typeof GateMailSchema>> = [];
// The code a mail carried, read off its confirm link.
const codeIn = (mail: z.infer<typeof GateMailSchema> | undefined): string => /code=(\d{6})/u.exec(mail?.html ?? ``)?.[1] ?? `none`;

const testAuth = () => {
    const allowances = memoryAllowances();
    const auth = betterAuth({
        secret: `test-secret-of-at-least-thirty-two-characters`,
        baseURL: ORIGIN,
        basePath: `/api/auth`,
        database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
        emailAndPassword: { enabled: false },
        plugins: [...emailCodes(gateConfig, allowances, logger)],
    });
    const call = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
        const response = await auth.handler(
            new Request(`${BASE}${path}`, { method: `POST`, headers: { origin: ORIGIN, "content-type": `application/json` }, body: JSON.stringify(body) }),
        );
        const text = await response.text();
        return { status: response.status, body: text === `` ? null : JSON.parse(text) };
    };
    const send = (email: string, returnTo?: string) =>
        call(returnTo === undefined ? SEND_CODE_PATH : `${SEND_CODE_PATH}?${new URLSearchParams({ returnTo })}`, { email, type: `sign-in` });
    const signIn = (email: string, otp: string) => call(`/sign-in/email-otp`, { email, otp });
    return { send, signIn };
};

describe(`the per-address gate, ahead of Better Auth`, () => {
    beforeEach(() => {
        clock = Date.now();
        mailed.length = 0;
        jest.spyOn(globalThis, `fetch`).mockImplementation(
            Object.assign(
                async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
                    mailed.push(GateMailSchema.parse(JSON.parse(String(init?.body))));
                    return new Response(`{}`, { status: 200 });
                },
                { preconnect: globalThis.fetch.preconnect },
            ),
        );
    });
    afterEach(() => {
        jest.restoreAllMocks();
        jest.setSystemTime();
    });

    // Time passing, for the allowance's windows and for which of two codes is the newer (Better Auth keeps both rows and
    // reads the latest, so two minted in the same millisecond would tie).
    let clock = Date.now();
    const later = (ms: number): void => {
        clock += ms;
        jest.setSystemTime(new Date(clock));
    };

    it(`leaves the mailed code working when a second send inside the minute is refused, and answers it alike`, async () => {
        const platform = testAuth();
        expect(await platform.send(`ada@example.org`)).toEqual({ status: 200, body: { success: true } });
        const first = codeIn(mailed[0]);
        // Still inside the minute, and late enough that a code minted now would be the newer one Better Auth reads.
        later(30_000);

        expect(await platform.send(`Ada@Example.org`)).toEqual({ status: 200, body: { success: true } });

        expect(mailed.map((mail) => mail.to)).toEqual([`ada@example.org`]);
        expect((await platform.signIn(`ada@example.org`, first)).status).toBe(200);
    });

    it(`changes nothing for an address past its hour's allowance, and still answers success`, async () => {
        const platform = testAuth();
        await platform.send(`ada@example.org`);
        for (let sent = 1; sent < 5; sent++) {
            later(61_000);
            await platform.send(`ada@example.org`);
        }
        const last = codeIn(mailed.at(-1));
        expect(mailed).toHaveLength(5);
        later(61_000);

        expect(await platform.send(`ada@example.org`)).toEqual({ status: 200, body: { success: true } });

        expect(mailed).toHaveLength(5);
        expect((await platform.signIn(`ada@example.org`, last)).status).toBe(200);
    });

    it(`mails a fresh code once the minute has passed, and that one replaces the last`, async () => {
        const platform = testAuth();
        await platform.send(`ada@example.org`);
        const first = codeIn(mailed[0]);
        later(61_000);

        expect(await platform.send(`ada@example.org`)).toEqual({ status: 200, body: { success: true } });

        expect(mailed.map((mail) => mail.to)).toEqual([`ada@example.org`, `ada@example.org`]);
        const second = codeIn(mailed[1]);
        expect(second).toMatch(/^\d{6}$/u);
        // Two fresh codes can only collide one time in a million; this run says which of them signs in.
        if (second !== first) {
            expect((await platform.signIn(`ada@example.org`, first)).status).toBe(400);
        }
        expect((await platform.signIn(`ada@example.org`, second)).status).toBe(200);
    });

    it(`mints and mails nothing for the canary's address, and answers it like any other`, async () => {
        const platform = testAuth();

        expect(await platform.send(`Canary@Intentic.test`)).toEqual({ status: 200, body: { success: true } });

        expect(mailed).toEqual([]);
        // Nothing was minted, so no six digits sign in as it.
        expect((await platform.signIn(`canary@intentic.test`, `000000`)).status).toBe(400);
    });

    // What the editor's send names on its query (useAuth's sendEmailCode) is the link's destination, by the same rule.
    it(`mails a link that returns to the page the send named, and none to a foreign one`, async () => {
        const platform = testAuth();
        expect((await platform.send(`ada@example.org`, `/desktop-auth?state=nonce&challenge=chal`)).status).toBe(200);
        later(61_000);
        expect((await platform.send(`ada@example.org`, `//evil.example`)).status).toBe(200);

        expect(mailed).toHaveLength(2);
        expect(mailed[0]?.html).toContain(`&amp;returnTo=%2Fdesktop-auth%3Fstate%3Dnonce%26challenge%3Dchal`);
        expect(mailed[1]?.html).not.toContain(`returnTo`);
        expect(mailed[1]?.html).not.toContain(`evil.example`);
    });

    it(`takes no allowance for a send the endpoint refuses`, async () => {
        const platform = testAuth();

        // The endpoint refuses an address with a space before it; the gate, which trims, must not have counted it as ada's.
        expect((await platform.send(` ada@example.org`)).status).toBe(400);
        expect((await platform.send(`ada@example.org`)).status).toBe(200);

        expect(mailed.map((mail) => mail.to)).toEqual([`ada@example.org`]);
    });
});
