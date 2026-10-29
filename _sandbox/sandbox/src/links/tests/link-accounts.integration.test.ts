import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { RunnerCredential } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { Hono } from "hono";
import pino from "pino";
import type { AppEnv } from "../../app-env.js";
import { opt } from "../../opt.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { memoryStartWindow } from "../../store/start-window.testing.js";
import { linkAccountCopy, linkAccounts, linkAsk, linkCredential, linkCredentialRefresh } from "../../sandboxes/link-client.js";
import type { StoredCursorAccount } from "../../runtimes/cursor/accounts/cursor-credentials.js";
import { borrowAccounts, type BorrowingDeps } from "../accounts/borrowing.js";
import { createBorrowedClaude } from "../accounts/borrowed-claude.js";
import { borrowedAccountsDocument, fileBorrowedStore } from "../accounts/borrowed-store.js";
import type { HeldAccount } from "../accounts/held-accounts.js";
import { createLinkAccountDoors } from "../accounts/link-account-doors.js";
import { fileInboundLinks, type InboundLinks, inboundLinksDocument } from "../inbound-links.js";
import { createLinkRoutes, linkAccountRoutes } from "../links.routes.js";

// TWO SANDBOXES, ONE ACCOUNTS LINK, OVER HTTP: the lending side's real account doors served on a port, against the
// borrowing side's real wire, lender and borrow flow. Only what the lending side holds is the suite's: a Claude
// sign-in it lends, one it does not, a Cursor key it lets copy. What is proven is the rule the feature rests on: a
// borrowed sign-in is handed access tokens and never its refresh token, and a link reaches only what its terms name.

const logger = pino({ level: "silent" });
const quiet = { info: () => undefined, warn: () => undefined };

const row = (id: string, extra: Partial<OauthAccount> = {}): OauthAccount => ({ id, label: id, connectedAt: 1, ...extra });

const HELD: readonly HeldAccount[] = [
    { ref: { provider: "claude", account: "acct-1" }, row: row("acct-1", { email: "me@example.com", usage: { windows: [], measuredAt: 1 } }), mode: "lend" },
    { ref: { provider: "claude", account: "acct-2" }, row: row("acct-2"), mode: "lend" },
    { ref: { provider: "cursor", account: "cur-1" }, row: row("cur-1", { email: "me@example.com" }), mode: "copy" },
    { ref: { provider: "claude", account: "lent-x" }, row: row("lent-x"), mode: "no", reason: "borrowed" },
];

interface Lender {
    readonly url: string;
    readonly links: InboundLinks;
    readonly asked: string[];
    readonly server: ServerType;
}

// The lending sandbox: its link store and the account doors (and the task doors, to prove an accounts link takes none).
const lendingSandbox = async (): Promise<Lender> => {
    const links = fileInboundLinks(join(mkdtempSync(join(tmpdir(), "lend-")), inboundLinksDocument.path));
    const asked: string[] = [];
    const deps = {
        links,
        conversations: memoryFleet().conversations,
        starts: memoryStartWindow(),
        notify: () => undefined,
        logger: quiet,
        auth: undefined,
        sandboxName: () => "ops",
        personas: async () => [],
        turns: { say: async () => ({ delivered: "started" as const, run: "run-1" }), reply: async () => "settled" as const, stop: async () => ({ stopped: true }) },
    };
    let minted = 0;
    const doors = createLinkAccountDoors({
        logger,
        held: async () => HELD,
        copyOf: async (ref) => (ref.provider === "cursor" ? { kind: "account", account: { apiKey: "cursor-key", email: "me@example.com" } } : undefined),
        credential: async ({ account }): Promise<RunnerCredential> => {
            asked.push(account ?? "");
            return { ok: true, kind: "oauth", accessToken: `access-${account ?? ""}`, ...opt("account", account) };
        },
        remint: async (_account, rejected) => {
            minted += 1;
            return `${rejected}-renewed-${minted}`;
        },
    });
    const app = new Hono<AppEnv>();
    for (const [key, handler] of Object.entries(linkAccountRoutes(deps, doors))) {
        const [method, path] = key.split(" ");
        app.on(method ?? "GET", path ?? "/", handler);
    }
    const routes = createLinkRoutes(deps);
    app.post("/link/conversations", routes.ask);
    app.post("/system/links/:id", routes.update);
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    // SAFETY: a server listening on a TCP host and port answers its address as AddressInfo, never as a pipe's name.
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, links, asked, server };
};

const accountsTerms = { tasks: false, approve: false, accounts: [{ provider: "claude", account: "acct-1" }, { provider: "cursor", account: "cur-1" }] };

const cardFor = async (lender: Lender): Promise<Capability> => {
    const minted = await lender.links.mint("dev", { terms: accountsTerms });
    return CapabilitySchema.parse({ id: "accounts-ops", kind: "link", config: { url: lender.url, token: minted.token, name: "ops", sandboxId: "sb-ops", purpose: "accounts" } });
};

const targetOf = (card: Capability) => {
    if (card.kind !== "link") {
        throw new Error("not a link card");
    }
    return { id: card.id, config: card.config };
};

describe("an accounts link, lending side", () => {
    let lender: Lender;
    beforeEach(async () => {
        lender = await lendingSandbox();
    });
    afterEach(() => {
        lender.server.close();
    });

    it("lists only the accounts its terms name, with no credential in a row", async () => {
        const answer = await linkAccounts(targetOf(await cardFor(lender)));
        expect(answer.ok).toBe(true);
        const accounts = answer.ok ? answer.value.accounts : [];
        expect(accounts.map((account) => `${account.provider}:${account.id}:${account.mode}`)).toEqual(["claude:acct-1:lend", "cursor:cur-1:copy"]);
        expect(JSON.stringify(accounts)).not.toContain("access-");
    });

    it("lends a named sign-in an access token, and refuses one the terms do not name", async () => {
        const target = targetOf(await cardFor(lender));
        const lent = await linkCredential(target, { agent: "claude", account: "acct-1" });
        expect(lent).toEqual({ ok: true, value: { ok: true, kind: "oauth", accessToken: "access-acct-1", account: "acct-1" } });
        const refused = await linkCredential(target, { agent: "claude", account: "acct-2" });
        expect(refused.ok).toBe(false);
        expect(refused.ok ? 0 : refused.status).toBe(404);
        expect(lender.asked).toEqual(["acct-1"]);
    });

    it("renews a refused token mid-turn, and copies only what its mode says may be copied", async () => {
        const target = targetOf(await cardFor(lender));
        const renewed = await linkCredentialRefresh(target, { account: "acct-1", rejected: "old" });
        expect(renewed).toEqual({ ok: true, value: { accessToken: "old-renewed-1" } });
        const copied = await linkAccountCopy(target, { provider: "cursor", account: "cur-1" });
        expect(copied.ok && copied.value.copy).toEqual({ kind: "account", account: { apiKey: "cursor-key", email: "me@example.com" } });
        const lentNotCopied = await linkAccountCopy(target, { provider: "claude", account: "acct-1" });
        expect(lentNotCopied.ok ? 0 : lentNotCopied.status).toBe(404);
    });

    it("takes no task over an accounts link, and answers a token it never minted as unknown", async () => {
        const target = targetOf(await cardFor(lender));
        const asked = await linkAsk(target, { requestId: "r-1", task: "do something", hops: 0 });
        expect(asked.ok ? 0 : asked.status).toBe(409);
        const stranger = await linkAccounts({ id: "x", config: { url: lender.url, token: "ilk_nothing" } });
        expect(stranger.ok ? 0 : stranger.status).toBe(401);
    });
});

describe("an accounts link's terms", () => {
    let lender: Lender;
    beforeEach(async () => {
        lender = await lendingSandbox();
    });
    afterEach(() => {
        lender.server.close();
    });

    it("keeps taking no tasks when a change names only its accounts", async () => {
        const minted = await lender.links.mint("dev", { terms: accountsTerms });
        const response = await fetch(`${lender.url}/system/links/${minted.id}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ accounts: [{ provider: "claude", account: "acct-1" }] }),
        });
        expect(response.status).toBe(200);
        expect((await lender.links.resolve(minted.token))?.terms).toMatchObject({ tasks: false, approve: false, accounts: [{ provider: "claude", account: "acct-1" }] });
    });
});

describe("an accounts link, borrowing side", () => {
    let lender: Lender;
    beforeEach(async () => {
        lender = await lendingSandbox();
    });
    afterEach(() => {
        lender.server.close();
    });

    const borrowing = (card: Capability) => {
        const store = fileBorrowedStore(join(mkdtempSync(join(tmpdir(), "borrow-")), borrowedAccountsDocument.path));
        const cursor = new Map<string, StoredCursorAccount>();
        let settled = 0;
        const deps: BorrowingDeps = {
            store,
            cards: async () => [card],
            copies: {
                cursorStore: {
                    read: async (id) => cursor.get(id),
                    write: async (account) => {
                        cursor.set(account.id, account);
                    },
                    clear: async (id) => {
                        cursor.delete(id);
                    },
                    list: async () => [...cursor.values()].map((stored) => row(stored.id, stored.email === undefined ? {} : { email: stored.email })),
                    credentials: async () => [...cursor.values()],
                    logger,
                },
                // SAFETY: never reached: a Cursor copy and a Claude borrow are the only two this suite brings in.
                devinStore: undefined as never,
                // SAFETY: never reached, as above.
                devinModels: undefined as never,
                // SAFETY: never reached, as above.
                minted: undefined as never,
                // SAFETY: never reached, as above: no endpoint is copied here.
                capabilities: undefined as never,
                addEndpoint: async () => undefined,
            },
            settle: async () => {
                settled += 1;
            },
            borrowed: () => undefined,
            logger,
        };
        return { store, cursor, deps, settledCount: () => settled };
    };

    it("copies a static key into its own store and files a lent sign-in as borrowed, never its token", async () => {
        const card = await cardFor(lender);
        const { store, cursor, deps, settledCount } = borrowing(card);
        const brought = await borrowAccounts(deps, {
            card: card.id,
            items: [
                { provider: "cursor", account: "cur-1" },
                { provider: "claude", account: "acct-1" },
                { provider: "claude", account: "acct-2" },
            ],
        });
        expect(brought.results.map((result) => result.outcome)).toEqual(["copied", "borrowed", "failed"]);
        expect([...cursor.values()].map((stored) => stored.apiKey)).toEqual(["cursor-key"]);
        expect(settledCount()).toBe(1);
        const filed = await store.list();
        expect(filed).toHaveLength(1);
        expect(filed[0]).toMatchObject({ provider: "claude", remote: "acct-1", from: { name: "ops", sandboxId: "sb-ops" } });
        expect(JSON.stringify(filed)).not.toContain("access-");
        // Bringing the same account in again leaves one row, same id.
        const again = await borrowAccounts(deps, { card: card.id, items: [{ provider: "claude", account: "acct-1" }] });
        expect(again.results[0]?.id).toBe(filed[0]?.id);
        expect(await store.list()).toHaveLength(1);
    });

    it("lists a borrowed sign-in with the lender's reading, and leases its token once until it is refused", async () => {
        const card = await cardFor(lender);
        const { store, deps } = borrowing(card);
        await borrowAccounts(deps, { card: card.id, items: [{ provider: "claude", account: "acct-1" }] });
        const lenderSide = createBorrowedClaude({ store, cards: async () => [card], logger });
        const [listed] = await lenderSide.rows();
        expect(listed).toMatchObject({ email: "me@example.com", borrowedFrom: { name: "ops", sandboxId: "sb-ops" }, usage: { windows: [], measuredAt: 1 } });
        const id = listed?.id ?? "";
        expect(lenderSide.owns(id)).toBe(true);
        expect(await lenderSide.token(id)).toBe("access-acct-1");
        expect(await lenderSide.token(id)).toBe("access-acct-1");
        expect(lender.asked).toEqual(["acct-1"]);
        expect(await lenderSide.replace(id, "access-acct-1")).toBe("access-acct-1-renewed-1");
        // Another turn refused with the token already replaced is handed the replacement, not a second renewal.
        expect(await lenderSide.replace(id, "access-acct-1")).toBe("access-acct-1-renewed-1");
    });

    it("says the lender is not answering, rather than spending a stale token or another account", async () => {
        const card = await cardFor(lender);
        const { store, deps } = borrowing(card);
        await borrowAccounts(deps, { card: card.id, items: [{ provider: "claude", account: "acct-1" }] });
        lender.server.close();
        const lenderSide = createBorrowedClaude({ store, cards: async () => [card], logger });
        const [listed] = await lenderSide.rows();
        expect(listed?.detail).toContain("ops is not answering");
        await expect(lenderSide.token(listed?.id ?? "")).rejects.toThrow(/ops did not lend this account a token/);
    });
});
