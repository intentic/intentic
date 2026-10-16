import { apiContract, type SandboxSummary } from "@intentic/api-contract";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import {
    installMachinePlatform,
    MACHINE_EMAIL,
    type MachineFace,
    type MachineSandbox,
    machinePlatformAnswer,
    NEEDS_INTERNET,
    openingSandbox,
    rowsOf,
    sandboxKeyOf,
    seedSessions,
    userOf,
} from "./machineFace";
import { LOCAL_PLATFORM_ORIGIN } from "./origin";
import type { LocalSession } from "./platform";

// The sandbox face's platform stand-in: who is signed in, and this computer's sandboxes, each reached on its loopback port.

const NOW = new Date(`2026-10-16T12:00:00.000Z`);

const sandbox = (slug: string, extra: Partial<MachineSandbox> = {}): MachineSandbox => ({
    slug,
    name: slug,
    platformId: null,
    sandboxId: null,
    localPort: 30_238,
    running: true,
    asleep: false,
    session: { token: `tok-${slug}`, expiresAt: 99, email: `owner@example.com` },
    why: null,
    ...extra,
});

const FACE: MachineFace = {
    account: { email: `ada@example.com`, name: `Ada`, image: null },
    sandboxes: [
        sandbox(`lab`, { name: `Lab`, platformId: `cm1lab`, sandboxId: `3c469e9d6c58` }),
        sandbox(`nap`, { sandboxId: `ceec11462653`, localPort: 29_000, running: false, asleep: true, session: null }),
        // Publishes no loopback port: nowhere to send a call, so never listed.
        sandbox(`dev`, { localPort: null }),
    ],
    appUrl: `https://app.intentic.dev`,
};

// The contract's own reader of a procedure's answer, the schema the platform's server holds its answers to.
const outputSchemaOf = <Schema>(procedure: { readonly "~orpc": { readonly outputSchema?: Schema } }): Schema => {
    const schema = procedure[`~orpc`].outputSchema;
    if (schema === undefined) {
        throw new Error(`the procedure declares no output`);
    }
    return schema;
};

const answer = async (path: string): Promise<{ status: number; body: unknown }> => {
    const response = machinePlatformAnswer(FACE, new URL(path, LOCAL_PLATFORM_ORIGIN), NOW);
    return { status: response.status, body: await response.json() };
};

afterEach(() => {
    unstubAllGlobals();
});

describe(`the rows the editor lists`, () => {
    it(`keys a sandbox by the platform's id, and one the platform never named by this machine's own`, () => {
        expect(sandboxKeyOf(FACE.sandboxes[0] ?? sandbox(`x`))).toBe(`cm1lab`);
        expect(sandboxKeyOf(sandbox(`nap`, { sandboxId: `ceec11462653` }))).toBe(`machine-ceec11462653`);
        expect(sandboxKeyOf(sandbox(`dev`))).toBe(`machine-dev`);
    });

    it(`lists every sandbox with a loopback port, owned, dialled there with no connect token`, async () => {
        const { status, body } = await answer(`/rpc/sandbox/list`);
        expect(status).toBe(200);
        const parsed = outputSchemaOf(apiContract.sandbox.list).parse(body);
        const lab: SandboxSummary = {
            id: `cm1lab`,
            name: `Lab`,
            image: null,
            daemonUrl: `http://127.0.0.1:30238`,
            lastSeenAt: NOW.toISOString(),
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
        expect(parsed.sandboxes).toEqual([lab, { ...lab, id: `machine-ceec11462653`, name: `nap`, daemonUrl: `http://127.0.0.1:29000` }]);
        expect(rowsOf(FACE, NOW).map((row) => row.id)).toEqual([`cm1lab`, `machine-ceec11462653`]);
    });
});

describe(`who the page runs as`, () => {
    it(`is the account the workspace last named, else the owner a session was minted for, else a placeholder`, async () => {
        const { body } = await answer(`/api/auth/get-session`);
        // SAFETY: the stand-in's get-session answer, built from LocalSession just above it.
        expect((body as LocalSession).user).toEqual({ id: `machine:ada@example.com`, email: `ada@example.com`, name: `Ada`, image: null });
        expect(outputSchemaOf(apiContract.me.get).parse((await answer(`/rpc/me`)).body)).toMatchObject({ email: `ada@example.com` });
        expect(userOf({ ...FACE, account: null }).email).toBe(`owner@example.com`);
        expect(userOf({ ...FACE, account: null, sandboxes: [sandbox(`nap`, { session: null })] }).email).toBe(MACHINE_EMAIL);
        // Any other auth call answers, so the client never reads a refusal as being signed out.
        expect((await answer(`/api/auth/sign-out`)).status).toBe(200);
    });
});

describe(`what needs the platform`, () => {
    it(`says so in plain words, as a 503 rather than a thing that does not exist`, async () => {
        for (const path of [`/rpc/hosted-plan`, `/rpc/tokens/create`, `/rpc/sandbox/create`, `/rpc/share`, `/api/identity`]) {
            expect(await answer(path)).toEqual({ status: 503, body: { message: NEEDS_INTERNET } });
        }
        expect(NEEDS_INTERNET).not.toMatch(/platform|503|daemon|loopback/i);
        expect(outputSchemaOf(apiContract.sandbox.trash).parse((await answer(`/rpc/sandbox/trash`)).body)).toEqual({ sandboxes: [] });
    });

    it(`answers only the stand-in's origin in the page, and lets every other request through`, async () => {
        const seen: string[] = [];
        stubGlobal(`window`, { location: { href: `tauri://localhost/files/sandbox` } });
        stubGlobal(`fetch`, (input: string | URL | Request): Promise<Response> => {
            seen.push(String(input));
            return Promise.resolve(new Response(`{}`));
        });
        installMachinePlatform(() => FACE, LOCAL_PLATFORM_ORIGIN);
        const list = await fetch(`${LOCAL_PLATFORM_ORIGIN}/rpc/sandbox/list`);
        expect(outputSchemaOf(apiContract.sandbox.list).parse(await list.json()).sandboxes).toHaveLength(2);
        await fetch(`http://127.0.0.1:30238/agents`);
        expect(seen).toEqual([`http://127.0.0.1:30238/agents`]);
    });
});

describe(`the sessions the editor finds`, () => {
    it(`are each minted session under the sandbox's id, with the loopback question answered`, () => {
        const written = new Map<string, string>();
        const seeded = seedSessions(FACE, { setItem: (key, value) => void written.set(key, value) });
        expect(seeded).toEqual([`cm1lab`]);
        expect(JSON.parse(written.get(`intentic.session.cm1lab`) ?? `null`)).toEqual({ token: `tok-lab`, expiresAt: 99, email: `owner@example.com` });
        // Asleep: no session to give, and nothing written over one an earlier spell left.
        expect(written.has(`intentic.session.machine-ceec11462653`)).toBe(false);
        expect(written.get(`intentic.localShortcut.declined.machine-ceec11462653`)).toBe(`yes`);
        expect([...written.keys()].some((key) => key.includes(`dev`))).toBe(false);
    });

    it(`opens on the sandbox the page was on while it is still here, else the first that runs with a session`, () => {
        expect(openingSandbox(FACE, `machine-ceec11462653`)).toBe(`machine-ceec11462653`);
        expect(openingSandbox(FACE, `gone`)).toBe(`cm1lab`);
        expect(openingSandbox(FACE, null)).toBe(`cm1lab`);
        expect(openingSandbox({ ...FACE, sandboxes: [sandbox(`nap`, { running: false, session: null })] }, null)).toBe(`machine-nap`);
        expect(openingSandbox({ ...FACE, sandboxes: [] }, null)).toBeUndefined();
    });
});
