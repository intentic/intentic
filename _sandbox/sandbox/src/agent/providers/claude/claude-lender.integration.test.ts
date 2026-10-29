import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { ensureFreshToken, fileClaudeStore, replaceRejectedToken, startClaudeRefresh } from "./claude-credentials.js";
import { type ClaudeLender, withLender } from "./claude-lender.js";

// A BORROWED CLAUDE ACCOUNT BESIDE THE STORE'S OWN: listed with them, every token for it asked of the lender, and never
// written to this sandbox's files, so nothing here ever holds or renews the refresh token another sandbox renews.

const silent = pino({ level: "silent" });
const BORROWED = "lent-1";

const lenderOf = (calls: string[]): ClaudeLender => ({
    owns: (id) => id === BORROWED,
    rows: async () => [{ id: BORROWED, label: "Borrowed", connectedAt: 2, borrowedFrom: { name: "ops" } }],
    token: async (id) => {
        calls.push(`token:${id}`);
        return "lent-access";
    },
    replace: async (id, rejected) => {
        calls.push(`replace:${id}:${rejected}`);
        return "lent-access-2";
    },
    forget: async (id) => {
        calls.push(`forget:${id}`);
    },
});

const storeWith = async (calls: string[]) => {
    const own = fileClaudeStore(mkdtempSync(join(tmpdir(), "claude-lender-")), silent);
    // A fresh token with an hour left: served as it is, never rotated by this suite.
    await own.write({ id: "own-1", accessToken: "own-access", refreshToken: "own-refresh", expiresAt: Date.now() + 3_600_000, connectedAt: 1 });
    return withLender(own, () => lenderOf(calls));
};

describe("a Claude store with a lender", () => {
    it("lists the borrowed account beside its own, and reads only its own", async () => {
        const store = await storeWith([]);
        expect((await store.list()).map((account) => account.id)).toEqual(["own-1", BORROWED]);
        expect(await store.read(BORROWED)).toBeUndefined();
        expect((await store.read("own-1"))?.accessToken).toBe("own-access");
    });

    it("asks the lender for a borrowed account's tokens, and serves its own from its files", async () => {
        const calls: string[] = [];
        const store = await storeWith(calls);
        expect(await ensureFreshToken(store, BORROWED)).toBe("lent-access");
        expect(await replaceRejectedToken(store, BORROWED, "lent-access")).toBe("lent-access-2");
        expect(await ensureFreshToken(store, "own-1")).toBe("own-access");
        expect(calls).toEqual([`token:${BORROWED}`, `replace:${BORROWED}:lent-access`]);
    });

    it("never writes a borrowed account, and clearing one forgets it at the lender", async () => {
        const calls: string[] = [];
        const store = await storeWith(calls);
        await expect(store.write({ id: BORROWED, accessToken: "x", connectedAt: 1 })).rejects.toThrow(/held by the sandbox that lends it/);
        await store.clear(BORROWED);
        expect(calls).toEqual([`forget:${BORROWED}`]);
        expect((await store.list()).map((account) => account.id)).toContain("own-1");
    });

    it("leaves a borrowed account out of the background renewal", async () => {
        const calls: string[] = [];
        const store = await storeWith(calls);
        const stop = startClaudeRefresh(store, 60_000, async () => {
            throw new Error("no renewal is expected in this suite");
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        stop();
        expect(calls).toEqual([]);
    });
});
