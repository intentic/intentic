import { accountsContract } from "@intentic/sandbox-contract/contracts/accounts.contract";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { Services } from "../../composition.js";
import type { ProvenCaller } from "../../auth/auth.js";
import type { AccountConnectorsStore } from "../../auth/members/account-connectors.js";
import { memoryAccountConnectors } from "../../auth/members/account-connectors.testing.js";
import { errorCode, proven, routesClient } from "../../harness/route-client.testing.js";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import { createAccountsRoutes } from "./accounts.routes.js";
import type { AccountDoor } from "../providers/provider-module.js";

/* The one route family over every account door: what these prove is the part no door owns. */

const ROW: OauthAccount = { id: "a", label: "Work", connectedAt: 1 };

const fakeDoor = (over: Partial<AccountDoor> = {}): AccountDoor => ({
    start: async () => ({ url: "https://vendor.example/sign-in", code: "", state: "", flow: "device", variant: "", handshake: "h1", expiresAt: 10 }),
    cancel: () => {},
    list: async () => [],
    rename: async () => undefined,
    identityOf: () => undefined,
    forget: async () => {},
    ...over,
});

type Doors = Parameters<typeof createAccountsRoutes>[1];

const routeServices = (accountConnectors: AccountConnectorsStore = memoryAccountConnectors(), logger = recordingLogger().logger): Services =>
    ({ providerRefusals: { read: async () => ({}), onFile: async () => ({}) }, accountConnectors, logger }) as unknown as Services;
const client = (doors: Doors) => routesClient(accountsContract, createAccountsRoutes(routeServices(), doors));

test("a provider without a door is not found, whatever the verb", async () => {
    const accounts = client({ claude: fakeDoor() });
    expect(await errorCode(accounts.accounts({ provider: "codex" }))).toBe("NOT_FOUND");
    expect(await errorCode(accounts.start({ provider: "kimi" }))).toBe("NOT_FOUND");
    expect(await errorCode(accounts.disconnect({ provider: "gemini", id: "x" }))).toBe("NOT_FOUND");
    expect(await accounts.accounts({ provider: "claude" })).toEqual({ accounts: [] });
});

test("a door's own refusal is the route's precondition failure, in the door's words", async () => {
    const accounts = client({
        cursor: fakeDoor({
            start: async () => {
                throw new Error("The Cursor SDK download failed: npm registry unavailable.");
            },
        }),
    });
    const failure = await accounts.start({ provider: "cursor" }).then(
        () => undefined,
        (error: { code: string; message: string }) => error,
    );
    expect(failure?.code).toBe("PRECONDITION_FAILED");
    expect(failure?.message).toBe("The Cursor SDK download failed: npm registry unavailable.");
});

test("finishing answers with the account where the exchange ends here, and with nothing where a mint follows", async () => {
    const seen: string[] = [];
    const accounts = client({
        claude: fakeDoor({
            complete: async ({ handshake, code, label }) => {
                seen.push(`${handshake}:${code}:${label}`);
                return ROW;
            },
        }),
        meta: fakeDoor({ complete: async () => undefined }),
        grok: fakeDoor(),
    });
    expect(await accounts.complete({ provider: "claude", handshake: "h1", code: "abc#h1", label: "Work" })).toEqual({ account: ROW });
    expect(seen).toEqual(["h1:abc#h1:Work"]);
    expect(await accounts.complete({ provider: "meta", handshake: "h2", redirectUrl: "http://127.0.0.1:8317/callback?authCode=x" })).toEqual({});
    // A device door has nothing to finish, and the route says so rather than pretending to.
    expect(await errorCode(accounts.complete({ provider: "grok", handshake: "h3", code: "x" }))).toBe("PRECONDITION_FAILED");
});

test("a rename that matched nothing is 404, and force reaches the door's list", async () => {
    const forced: boolean[] = [];
    const accounts = client({
        claude: fakeDoor({
            list: async (force) => {
                forced.push(force);
                return [ROW];
            },
            rename: async (id, label) => (id === "a" ? { ...ROW, label } : undefined),
        }),
    });
    expect(await accounts.rename({ provider: "claude", id: "a", label: "Job" })).toEqual({ ...ROW, label: "Job" });
    expect(await errorCode(accounts.rename({ provider: "claude", id: "gone", label: "Job" }))).toBe("NOT_FOUND");
    // Rows carry the facts the one serviceability rule judges, never a verdict of their own.
    expect(await accounts.accounts({ provider: "claude" })).toEqual({ accounts: [ROW] });
    await accounts.accounts({ provider: "claude", force: "1" });
    expect(forced).toEqual([false, true]);
});

/* Who connected each account: a person's sign-in is theirs however it ends, and below Full access only theirs to rename
 * or disconnect. */

const BOB: ProvenCaller = { ...proven("bob@example.com", "collaborator"), manages: ["ownAccounts"] };
const CY: ProvenCaller = { ...proven("cy@example.com", "collaborator"), manages: ["ownAccounts"] };
const MAY = proven("may@example.com", "maintainer");

// One route family over these doors as several callers reach it, so an attempt one starts is what a later listing reads.
const sandbox = (doors: Doors, accountConnectors: AccountConnectorsStore = memoryAccountConnectors()) => {
    const routes = createAccountsRoutes(routeServices(accountConnectors), doors);
    return { accountConnectors, as: (identity?: ProvenCaller) => routesClient(accountsContract, routes, identity) };
};

// A door listing whatever `rows` holds now, each sign-in a fresh handshake still answerable for a minute.
const listedDoor = (rows: OauthAccount[], over: Partial<AccountDoor> = {}): AccountDoor => {
    let handshakes = 0;
    return fakeDoor({
        start: async () => {
            handshakes += 1;
            return { url: "https://vendor.example/sign-in", code: "", state: "", flow: "device", variant: "", handshake: `h${handshakes}`, expiresAt: Date.now() + 60_000 };
        },
        list: async () => [...rows],
        ...over,
    });
};

test("a person's sign-in that finishes here or in its status is recorded as theirs, and the list names them", async () => {
    const rows: OauthAccount[] = [];
    const { as, accountConnectors } = sandbox({
        claude: listedDoor(rows, {
            complete: async () => {
                rows.push(ROW);
                return ROW;
            },
        }),
        meta: listedDoor([], { status: () => ({ status: "ok", account: { ...ROW, id: "m" } }) }),
    });
    const { handshake } = await as(BOB).start({ provider: "claude" });
    expect(await as(BOB).complete({ provider: "claude", handshake, code: "abc" })).toEqual({ account: { ...ROW, connectedBy: "bob@example.com" } });
    expect(await as(CY).accounts({ provider: "claude" })).toEqual({ accounts: [{ ...ROW, connectedBy: "bob@example.com" }] });
    // An attempt only its status sees end is its starter's, whoever reads the status.
    const meta = await as(CY).start({ provider: "meta" });
    expect(await as().status({ provider: "meta", handshake: meta.handshake })).toEqual({ status: "ok", account: { ...ROW, id: "m", connectedBy: "cy@example.com" } });
    expect(await accountConnectors.all()).toEqual(
        new Map([
            ["claude:a", "bob@example.com"],
            ["meta:m", "cy@example.com"],
        ]),
    );
});

test("a row a device sign-in adds is told whose by the account list, unless someone else was signing in too", async () => {
    const rows: OauthAccount[] = [ROW];
    const { as } = sandbox({ grok: listedDoor(rows) });
    await as(BOB).start({ provider: "grok" });
    rows.push({ ...ROW, id: "b" });
    // The row already there before the sign-in began is not the one it added.
    expect(await as(CY).accounts({ provider: "grok" })).toEqual({ accounts: [ROW, { ...ROW, id: "b", connectedBy: "bob@example.com" }] });

    // Two people signing in at once: a new row could be either's, so it is left nobody's rather than guessed.
    const bobs = await as(BOB).start({ provider: "grok" });
    const cys = await as(CY).start({ provider: "grok" });
    rows.push({ ...ROW, id: "c" });
    expect((await as(BOB).accounts({ provider: "grok" })).accounts.at(-1)).toEqual({ ...ROW, id: "c" });

    // The owner's own tools sign in as nobody the sandbox can name, and that still makes the new row anybody's.
    await as(BOB).cancel({ provider: "grok", handshake: bobs.handshake });
    await as(CY).cancel({ provider: "grok", handshake: cys.handshake });
    await as(BOB).start({ provider: "grok" });
    await as().start({ provider: "grok" });
    rows.push({ ...ROW, id: "d" });
    expect((await as(BOB).accounts({ provider: "grok" })).accounts.at(-1)).toEqual({ ...ROW, id: "d" });
});

test("below Full access a person renames and disconnects only the accounts they connected, and Full access any", async () => {
    const forgotten: string[] = [];
    const { as, accountConnectors } = sandbox({
        claude: listedDoor([ROW, { ...ROW, id: "b" }], {
            rename: async (id, label) => ({ ...ROW, id, label }),
            forget: async (id) => {
                forgotten.push(id);
            },
        }),
    });
    await accountConnectors.record("claude:a", "bob@example.com", 1);
    await accountConnectors.record("claude:b", "cy@example.com", 1);
    const refusal = await as(BOB)
        .disconnect({ provider: "claude", id: "b" })
        .then(
            () => undefined,
            (error: { code: string; message: string }) => error,
        );
    expect(refusal).toMatchObject({ code: "FORBIDDEN", message: "you can rename or disconnect only the AI accounts you connected yourself" });
    expect(await errorCode(as(BOB).rename({ provider: "claude", id: "b", label: "Mine" }))).toBe("FORBIDDEN");
    expect(forgotten).toEqual([]);

    expect(await as(BOB).rename({ provider: "claude", id: "a", label: "Mine" })).toEqual({ ...ROW, label: "Mine" });
    expect(await as(BOB).disconnect({ provider: "claude", id: "a" })).toEqual({ ok: true });
    expect(await as(MAY).disconnect({ provider: "claude", id: "b" })).toEqual({ ok: true });
    expect(forgotten).toEqual(["a", "b"]);
    // A disconnected account's connector goes with it.
    expect(await accountConnectors.all()).toEqual(new Map());
});

test("a connector record that cannot be read or written costs the record, never the sign-in or the list", async () => {
    const unreadable = async (): Promise<never> => {
        throw new Error("history volume unreadable");
    };
    const { lines, logger } = recordingLogger();
    const broken: AccountConnectorsStore = { all: unreadable, record: unreadable, forget: unreadable, keysOf: unreadable };
    const routes = createAccountsRoutes(routeServices(broken, logger), { claude: listedDoor([ROW], { complete: async () => ROW }) });
    const bob = routesClient(accountsContract, routes, BOB);
    const { handshake } = await bob.start({ provider: "claude" });
    expect(await bob.complete({ provider: "claude", handshake, code: "abc" })).toEqual({ account: ROW });
    expect(await bob.accounts({ provider: "claude" })).toEqual({ accounts: [ROW] });
    // Whose an account is cannot be told, so a person below Full access is refused for now rather than let through.
    expect(await errorCode(bob.disconnect({ provider: "claude", id: "a" }))).toBe("SERVICE_UNAVAILABLE");
    expect(lines.filter((line) => line["level"] === "warn")).toHaveLength(3);
});
