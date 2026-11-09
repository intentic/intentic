import { apiContract, type SandboxSummary, type TrashedSandbox, type User, UserSchema } from "@intentic/api-contract";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { LocalFace } from "@intentic/web/local";
import type { AccountAnswer, AccountAsk } from "../src/desktop";
import { LOCAL_PLATFORM_ORIGIN } from "./origin";
import {
    installPlatform,
    type KeptList,
    type ListKeeping,
    LOCAL_EMAIL,
    type LocalSession,
    type OutputOf,
    type PlatformRelay,
    platformAnswer,
    storedListKeeping,
} from "./platform";
import { memoryStorage } from "./storage.testing";

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

describe(`installPlatform, with the app there to carry the account's calls`, () => {
    const asked: AccountAsk[] = [];
    const passedOn: (string | URL | Request)[] = [];
    let next: AccountAnswer = { status: 200, body: `{"tokens":[]}`, contentType: `application/json` };
    const relay: PlatformRelay = (ask) => {
        asked.push(ask);
        return Promise.resolve(next);
    };

    beforeEach(() => {
        asked.length = 0;
        passedOn.length = 0;
        next = { status: 200, body: `{"tokens":[]}`, contentType: `application/json` };
        stubGlobal(`window`, { location: { href: `http://127.0.0.1:47147/files/local` } });
        stubGlobal(`fetch`, (input: string | URL | Request): Promise<Response> => {
            passedOn.push(input);
            return Promise.resolve(new Response(`from the network`));
        });
        installPlatform(FACE, relay);
    });

    it(`sends the account's calls through the app: method, query and body as the API client asked`, async () => {
        const listed = await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/tokens?cursor=a%20b`);
        // As the editor's API client asks: a Request, with its credentials beside it.
        await fetch(new Request(`${LOCAL_PLATFORM_ORIGIN}/rpc/tokens/create`, { method: `POST`, body: `{"label":"ci"}` }), { credentials: `include` });
        await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/hosted-plan/portal`, { method: `POST` });
        expect(await listed.json()).toEqual({ tokens: [] });
        expect(asked).toEqual([
            { method: `GET`, path: `/rpc/tokens?cursor=a%20b` },
            { method: `POST`, path: `/rpc/tokens/create`, body: `{"label":"ci"}` },
            { method: `POST`, path: `/rpc/hosted-plan/portal` },
        ]);
        expect(passedOn).toEqual([]);
    });

    it(`keeps the folder's own answers in the page, who is signed in among them`, async () => {
        const session = await fetch(`${LOCAL_PLATFORM_ORIGIN}/api/auth/get-session`);
        const list = await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/sandbox/list`);
        // SAFETY: the stand-in's session, whose shape the suite above pins.
        const { user } = (await session.json()) as LocalSession;
        expect([user, list.status]).toEqual([USER, 200]);
        expect(asked).toEqual([]);
    });

    it(`answers as the platform did, a refusal and an empty answer alike`, async () => {
        next = { status: 401, body: `{"message":"Not signed in."}`, contentType: `application/json` };
        const refused = await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/hosted-plan`);
        expect([refused.status, refused.headers.get(`content-type`), await refused.json()]).toEqual([401, `application/json`, { message: `Not signed in.` }]);
        next = { status: 204, body: ``, contentType: null };
        const empty = await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/tokens/revoke`, { method: `POST`, body: `{"tokenId":"t1"}` });
        expect([empty.status, await empty.text()]).toEqual([204, ``]);
    });

    // The first list is the boot guard's, which must not wait on the network; every later one is the switcher's.
    it(`lists the folder alone at once first, then the account's sandboxes after it, through the app`, async () => {
        const theirs: SandboxSummary = {
            ...outputSchemaOf(apiContract.sandbox.list).parse((await answer(`/rpc/sandbox/list`)).body).sandboxes[0]!,
            id: `sbx-work`,
            name: `work`,
            daemonUrl: `https://work.intentic.dev`,
        };
        next = { status: 200, body: JSON.stringify({ sandboxes: [theirs] }), contentType: `application/json` };
        const ids = async (): Promise<readonly string[]> => {
            // SAFETY: the contract's list, whose shape the suite above pins.
            const { sandboxes } = (await (await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/sandbox/list`)).json()) as OutputOf<typeof apiContract.sandbox.list>;
            return sandboxes.map((row) => row.id);
        };
        const first = await ids();
        const later = await ids();
        next = { status: 401, body: `{"message":"Not signed in."}`, contentType: `application/json` };
        const signedOut = await ids();
        expect({ first, later, signedOut, asked }).toEqual({
            first: [`local-f3a9c2`],
            later: [`local-f3a9c2`, `sbx-work`],
            signedOut: [`local-f3a9c2`],
            asked: [
                { method: `GET`, path: `/rpc/sandbox/list` },
                { method: `GET`, path: `/rpc/sandbox/list` },
            ],
        });
    });

    it(`removes and leaves the account's sandboxes through the app`, async () => {
        next = { status: 200, body: `{}`, contentType: `application/json` };
        await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/sandbox/delete`, { method: `POST`, body: `{"sandboxId":"sbx-work"}` });
        await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/sandbox/leave`, { method: `POST`, body: `{"sandboxId":"sbx-shared"}` });
        expect(asked).toEqual([
            { method: `POST`, path: `/rpc/sandbox/delete`, body: `{"sandboxId":"sbx-work"}` },
            { method: `POST`, path: `/rpc/sandbox/leave`, body: `{"sandboxId":"sbx-shared"}` },
        ]);
    });

    it(`rejects as a fetch does when the app cannot reach the platform`, async () => {
        const unreachable: PlatformRelay = () => Promise.reject(new Error(`The platform could not be reached.`));
        installPlatform(FACE, unreachable);
        await expect(fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/me/export`)).rejects.toThrow(`The platform could not be reached.`);
    });
});

// Another of the account's sandboxes, as the platform lists it to its owner: under its logo, with its connect token.
const owned = (id: string, name: string): SandboxSummary => ({
    id,
    name,
    image: `data:image/webp;base64,UklGRg==`,
    daemonUrl: `https://${name}.intentic.dev`,
    lastSeenAt: null,
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    token: `connect-token-${name}`,
    role: `owner`,
    providedAddress: false,
    localHostname: null,
    hosted: null,
});
const WORK = owned(`sbx-work`, `work`);
const SHOP = owned(`sbx-shop`, `shop`);

describe(`installPlatform, the last list the platform gave`, () => {
    const listed = (...rows: SandboxSummary[]): AccountAnswer => ({ status: 200, body: JSON.stringify({ sandboxes: rows }), contentType: `application/json` });

    let next: AccountAnswer | Error;
    let signedIn: string | null;
    let stored: KeptList | undefined;
    const written: (KeptList | undefined)[] = [];
    const relay: PlatformRelay = () => (next instanceof Error ? Promise.reject(next) : Promise.resolve(next));
    // The window's storage and the app's roster, as a test holds them.
    const keeping: ListKeeping = {
        whose: () => Promise.resolve(signedIn),
        read: () => stored,
        write: (kept) => {
            stored = kept;
            written.push(kept);
        },
    };
    // Each list as the editor reads it, the boot guard's first ask already answered.
    const list = async (): Promise<readonly SandboxSummary[]> => {
        // SAFETY: the contract's list, whose shape the first suite pins.
        const { sandboxes } = (await (await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/sandbox/list`)).json()) as OutputOf<typeof apiContract.sandbox.list>;
        return sandboxes;
    };
    const ids = async (): Promise<readonly string[]> => (await list()).map((sandbox) => sandbox.id);
    const opened = async (): Promise<void> => {
        installPlatform(FACE, relay, keeping);
        await ids();
    };

    beforeEach(() => {
        next = listed(WORK, SHOP);
        signedIn = `ada@example.com`;
        stored = undefined;
        written.length = 0;
        stubGlobal(`window`, { location: { href: `http://127.0.0.1:47147/files/local` } });
        stubGlobal(`fetch`, (): Promise<Response> => Promise.resolve(new Response(`from the network`)));
    });

    it(`lists the folder and the last list when the platform cannot be reached, errs, or answers out of shape`, async () => {
        await opened();
        const live = await ids();
        next = new Error(`The platform could not be reached.`);
        const unreachable = await list();
        next = { status: 530, body: `<html>Origin unreachable</html>`, contentType: `text/html` };
        const erring = await ids();
        next = { status: 200, body: `{"sandboxes":[{"id":"half"}]}`, contentType: `application/json` };
        const malformed = await ids();
        expect({ live, erring, malformed }).toEqual({
            live: [`local-f3a9c2`, `sbx-work`, `sbx-shop`],
            erring: [`local-f3a9c2`, `sbx-work`, `sbx-shop`],
            malformed: [`local-f3a9c2`, `sbx-work`, `sbx-shop`],
        });
        // Each row as the platform gave it, but with no connect token.
        expect(unreachable).toEqual([expect.objectContaining({ id: `local-f3a9c2` }), { ...WORK, token: null }, { ...SHOP, token: null }]);
    });

    it(`keeps the list for the next window under the account the app names, never with a connect token`, async () => {
        await opened();
        await ids();
        expect(written).toEqual([{ email: `ada@example.com`, sandboxes: [{ ...WORK, token: null }, { ...SHOP, token: null }] }]);
        // The next window, with the platform out of reach from its first ask after the boot guard's.
        next = new Error(`The platform could not be reached.`);
        await opened();
        expect(await ids()).toEqual([`local-f3a9c2`, `sbx-work`, `sbx-shop`]);
        // Another account signed in since, or nobody named: the copy is not theirs to see.
        signedIn = `bob@example.com`;
        expect(await ids()).toEqual([`local-f3a9c2`]);
        signedIn = null;
        expect(await ids()).toEqual([`local-f3a9c2`]);
    });

    it(`holds the list in the window's memory where storage keeps nothing`, async () => {
        const forgetful: ListKeeping = { ...keeping, read: () => undefined, write: () => undefined };
        installPlatform(FACE, relay, forgetful);
        await ids();
        await ids();
        next = new Error(`The platform could not be reached.`);
        expect(await ids()).toEqual([`local-f3a9c2`, `sbx-work`, `sbx-shop`]);
    });

    it(`replaces the list with every list the platform gives, an empty one included, and forgets it once nobody is signed in`, async () => {
        await opened();
        await ids();
        next = listed(SHOP);
        const fewer = await ids();
        next = new Error(`The platform could not be reached.`);
        const afterFewer = await ids();
        next = listed();
        const none = await ids();
        next = new Error(`The platform could not be reached.`);
        const afterNone = await ids();
        next = listed(WORK);
        await ids();
        next = { status: 401, body: `{"message":"Not signed in."}`, contentType: `application/json` };
        const signedOut = await ids();
        next = new Error(`The platform could not be reached.`);
        const afterSignOut = await ids();
        expect({ fewer, afterFewer, none, afterNone, signedOut, afterSignOut, stored }).toEqual({
            fewer: [`local-f3a9c2`, `sbx-shop`],
            afterFewer: [`local-f3a9c2`, `sbx-shop`],
            none: [`local-f3a9c2`],
            afterNone: [`local-f3a9c2`],
            signedOut: [`local-f3a9c2`],
            afterSignOut: [`local-f3a9c2`],
            stored: undefined,
        });
    });

    it(`keeps nothing under nobody: a list the app can name no account for is not kept`, async () => {
        signedIn = null;
        await opened();
        await ids();
        expect(written).toEqual([]);
    });
});

describe(`storedListKeeping, in this origin's storage`, () => {
    const realLocal = Object.getOwnPropertyDescriptor(globalThis, `localStorage`);
    let local: Storage;

    beforeEach(() => {
        local = memoryStorage();
        Object.defineProperty(globalThis, `localStorage`, { value: local, configurable: true });
    });

    afterAll(() => {
        if (realLocal === undefined) {
            Reflect.deleteProperty(globalThis, `localStorage`);
        } else {
            Object.defineProperty(globalThis, `localStorage`, realLocal);
        }
    });

    it(`reads back what it wrote, forgets it, and takes nothing malformed for a list`, () => {
        const keeping = storedListKeeping(() => Promise.resolve(`ada@example.com`));
        const kept: KeptList = { email: `ada@example.com`, sandboxes: [{ ...WORK, token: null }] };
        keeping.write(kept);
        expect(keeping.read()).toEqual(kept);
        expect(local.length).toBe(1);
        keeping.write(undefined);
        expect([keeping.read(), local.length]).toEqual([undefined, 0]);
        local.setItem(`intentic.local.accountSandboxes`, `{"email":"ada@example.com","sandboxes":[{"id":"half"}]}`);
        expect(keeping.read()).toBeUndefined();
        local.setItem(`intentic.local.accountSandboxes`, `not json`);
        expect(keeping.read()).toBeUndefined();
    });
});
