import { accountsContract, type OauthAccount } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../../composition.js";
import { errorCode, routesClient } from "../../harness/route-client.testing.js";
import { createAccountsRoutes } from "./accounts.routes.js";
import type { AccountDoor } from "../providers/provider-module.js";

/* The one route family over every account door: what these prove is the part no door owns. Which provider was
 * asked for and whether it has a door at all, how a door's own refusal reaches the wire, and the two answers a
 * finishing call can give. The doors themselves are tested where they live (claude/claude-accounts.test.ts). */

const ROW: OauthAccount = { id: "a", label: "Work", connectedAt: 1 };

const fakeDoor = (over: Partial<AccountDoor> = {}): AccountDoor => ({
    start: async () => ({ url: "https://vendor.example/sign-in", code: "", state: "", flow: "device", variant: "", handshake: "h1", expiresAt: 10 }),
    cancel: () => {},
    list: async () => [],
    rename: async () => undefined,
    disconnect: async () => {},
    ...over,
});

const client = (doors: Parameters<typeof createAccountsRoutes>[1]) => routesClient(accountsContract, createAccountsRoutes({} as Services, doors));

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
    await accounts.accounts({ provider: "claude" });
    await accounts.accounts({ provider: "claude", force: "1" });
    expect(forced).toEqual([false, true]);
});
