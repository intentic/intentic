import { generateKeyPairSync } from "node:crypto";
import { pino } from "pino";
import { z } from "zod";
import { configSchema, type Config } from "./config.js";
import {
    type CodeAllowanceRow,
    type CodeAllowances,
    emailSignInEnabled,
    identityKeyOf,
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

// The allowance table in memory, the one seam the per-address limit reads and writes.
const memoryAllowances = (): CodeAllowances => {
    const rows = new Map<string, CodeAllowanceRow>();
    return {
        read: async (key) => rows.get(key) ?? null,
        restart: async (key, windowStart) => void rows.set(key, { count: 1, windowStart }),
        increment: async (key) => {
            const held = rows.get(key);
            if (held !== undefined) {
                rows.set(key, { ...held, count: held.count + 1 });
            }
        },
    };
};

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
            await sendSignInCode({ config: configWith(), allowances: memoryAllowances(), logger }, { email: `Ada@Example.org`, code: `012345` });
            expect(mailed).toEqual([{ from: `intentic <hi@intentic.test>`, to: `ada@example.org`, subject: `Your intentic sign-in code`, html: expect.stringContaining(`012345`) }]);
            expect(mailed[0]?.html).toContain(`https://app.test/login/confirm?email=ada%40example.org&amp;code=012345`);
        });

        // An invite's link that resolves only here would strand its recipient; a sign-in code's recipient is the person at
        // this machine, and the code works wherever the link does not.
        it(`mails the code even where the confirm link resolves only on this machine`, async () => {
            await sendSignInCode({ config: configWith({ webOrigin: `http://localhost:47145` }), allowances: memoryAllowances(), logger }, { email: `ada@example.org`, code: `012345` });
            expect(mailed.map((mail) => mail.to)).toEqual([`ada@example.org`]);
            expect(mailed[0]?.html).toContain(`http://localhost:47145/login/confirm?email=ada%40example.org&amp;code=012345`);
        });

        it(`sends nothing to the canary's address, nor past an address's allowance, and says nothing different to the asker`, async () => {
            const deps = { config: configWith({ canaryEmail: `Canary@Intentic.test` }), allowances: memoryAllowances(), logger };
            await expect(sendSignInCode(deps, { email: `canary@intentic.test`, code: `111111` })).resolves.toBeUndefined();
            await sendSignInCode(deps, { email: `ada@example.org`, code: `222222` });
            await expect(sendSignInCode(deps, { email: `ada@example.org`, code: `333333` })).resolves.toBeUndefined();
            expect(mailed.map((mail) => mail.to)).toEqual([`ada@example.org`]);
            expect(mailed[0]?.html).toContain(`222222`);
        });
    });

    it(`names Google for an account with a Google account linked, and email wherever codes are mailed`, () => {
        expect(signInMethodsOf(true, configWith())).toEqual([`google`, `email`]);
        expect(signInMethodsOf(false, configWith())).toEqual([`email`]);
        expect(signInMethodsOf(true, configWith({ signIn: { email: `false` } }))).toEqual([`google`]);
    });

    it(`answers announces with the identity key's public half, and nothing on a platform that signs none`, () => {
        const pair = generateKeyPairSync(`ed25519`, { publicKeyEncoding: { type: `spki`, format: `pem` }, privateKeyEncoding: { type: `pkcs8`, format: `pem` } });
        expect(identityKeyOf(configWith({ signingKey: pair.privateKey }))).toBe(pair.publicKey);
        expect(identityKeyOf(configWith())).toBeUndefined();
    });
});
