import { apiContract, type SandboxSummary, type TrashedSandbox, type User, UserSchema } from "@intentic/api-contract";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { LocalFace } from "@intentic/web/local";
import { LOCAL_PLATFORM_ORIGIN } from "./origin";
import { installPlatform, LOCAL_EMAIL, type LocalSession, type OutputOf, platformAnswer } from "./platform";

// A window on one folder, as the app hands it over; the sidecar's loopback address is where its daemon calls go.
const FACE: LocalFace = { daemonUrl: `http://127.0.0.1:47148`, token: `window-bearer`, id: `f3a9c2`, name: `Taxes 2026`, path: `/home/ada/Taxes 2026` };
const NOW = new Date(`2026-09-28T12:00:00.000Z`);

const USER: User = { id: `local`, email: `you@this-computer.invalid`, name: ``, image: null };

// The contract's own reader of a procedure's answer, the schema the platform's server holds its answers to.
const outputSchemaOf = <Schema>(procedure: { readonly "~orpc": { readonly outputSchema?: Schema } }): Schema => {
    const schema = procedure["~orpc"].outputSchema;
    if (schema === undefined) {
        throw new Error(`the procedure declares no output`);
    }
    return schema;
};

const answer = async (path: string): Promise<{ status: number; type: string | null; body: unknown }> => {
    const response = platformAnswer(FACE, new URL(path, LOCAL_PLATFORM_ORIGIN));
    return { status: response.status, type: response.headers.get(`content-type`), body: await response.json() };
};

beforeEach(() => {
    jest.setSystemTime(NOW);
});

afterEach(() => {
    jest.setSystemTime();
    unstubAllGlobals();
});

describe(`platformAnswer, the contract's procedures`, () => {
    it(`lists the folder as the one sandbox, owned, whose daemon is the sidecar`, async () => {
        const { status, type, body } = await answer(`/rpc/sandbox/list`);
        const row: SandboxSummary = {
            id: `local-f3a9c2`,
            name: `Taxes 2026`,
            image: null,
            daemonUrl: `http://127.0.0.1:47148`,
            lastSeenAt: `2026-09-28T12:00:00.000Z`,
            setupCodeClaimedAt: null,
            setupReport: null,
            bootReport: null,
            announceRefusal: null,
            removedAt: null,
            removedBy: null,
            token: null,
            role: `owner`,
            providedAddress: false,
            localHostname: null,
            hosted: null,
        };
        expect({ status, type, body }).toEqual({ status: 200, type: `application/json`, body: { sandboxes: [row] } });
        expect(outputSchemaOf(apiContract.sandbox.list).parse(body)).toStrictEqual({ sandboxes: [row] });
        expectTypeOf<OutputOf<typeof apiContract.sandbox.list>>().toEqualTypeOf<{ sandboxes: SandboxSummary[] }>();
    });

    it(`has nothing in the trash`, async () => {
        const { status, body } = await answer(`/rpc/sandbox/trash`);
        expect({ status, body }).toEqual({ status: 200, body: { sandboxes: [] } });
        expect(outputSchemaOf(apiContract.sandbox.trash).parse(body)).toStrictEqual({ sandboxes: [] });
        expectTypeOf<OutputOf<typeof apiContract.sandbox.trash>>().toEqualTypeOf<{ sandboxes: TrashedSandbox[] }>();
    });

    it(`is one person, whose address the contract takes as an email`, async () => {
        const { status, body } = await answer(`/rpc/me`);
        expect({ status, body }).toEqual({ status: 200, body: USER });
        expect(outputSchemaOf(apiContract.me.get).parse(body)).toStrictEqual(USER);
        expect(LOCAL_EMAIL).toBe(USER.email);
        expectTypeOf<OutputOf<typeof apiContract.me.get>>().toEqualTypeOf<User | null>();
    });

    it(`answers anything else of the platform 404, in JSON`, async () => {
        expect(await answer(`/rpc/billing/plan`)).toEqual({
            status: 404,
            type: `application/json`,
            body: { message: `A local folder has no account behind it.` },
        });
    });
});

describe(`platformAnswer, better-auth's routes`, () => {
    it(`holds a session a year long for the one person, whose user the editor's reader takes as the contract's User`, async () => {
        const { status, type, body } = await answer(`/api/auth/get-session`);
        const session: LocalSession = { session: { id: `local`, userId: `local`, expiresAt: `2027-09-28T12:00:00.000Z` }, user: USER };
        expect({ status, type, body }).toEqual({ status: 200, type: `application/json`, body: session });
        // SAFETY: equal to a LocalSession, asserted just above.
        const { user } = body as LocalSession;
        expect(UserSchema.parse(user)).toStrictEqual(USER);
    });

    it(`answers every other auth call as done rather than 404, which the client would read as signed out`, async () => {
        expect(await answer(`/api/auth/sign-out`)).toEqual({ status: 200, type: `application/json`, body: { ok: true } });
    });
});

describe(`installPlatform`, () => {
    // Every call the page's fetch passed on, as the fetch it replaced received it.
    const passedOn: { input: string | URL | Request; init: RequestInit | undefined }[] = [];

    beforeEach(() => {
        passedOn.length = 0;
        stubGlobal(`window`, { location: { href: `http://127.0.0.1:47147/files/local` } });
        stubGlobal(`fetch`, (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            passedOn.push({ input, init });
            return Promise.resolve(new Response(`from the network`));
        });
        installPlatform(FACE);
    });

    it(`answers the platform's origin in the page, by address or by request`, async () => {
        const me = await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/me`);
        const list = await fetch(new Request(`${LOCAL_PLATFORM_ORIGIN}/rpc/sandbox/trash`));
        expect([await me.json(), await list.json()]).toEqual([USER, { sandboxes: [] }]);
        expect(passedOn).toEqual([]);
    });

    it(`passes every other origin to the fetch it replaced, untouched`, async () => {
        const init: RequestInit = { method: `POST`, body: `{}` };
        const response = await fetch(`http://127.0.0.1:47148/files/read`, init);
        expect(await response.text()).toBe(`from the network`);
        expect(passedOn).toEqual([{ input: `http://127.0.0.1:47148/files/read`, init }]);
        expect(passedOn[0]?.init).toBe(init);
    });

    it(`reads a relative address against the page's own, which is not the platform's`, async () => {
        await fetch(`/files/assets/local.js`);
        expect(passedOn).toEqual([{ input: `/files/assets/local.js`, init: undefined }]);
    });
});
