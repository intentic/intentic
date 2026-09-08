import type { AccountUsage, OauthAccount } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../../agents/registry/agents-store.js";
import { bookLimitMove, siblingWithRoom } from "./sibling-account.js";

const account = (id: string, extra: Partial<OauthAccount> = {}): OauthAccount => ({ id, label: id, ...extra }) as OauthAccount;
const reading = (utilization: number): AccountUsage => ({ windows: [{ kind: "five_hour", utilization, gates: "all" }], measuredAt: Date.now() }) as AccountUsage;

const fakeServices = (params: {
    readonly accounts: readonly OauthAccount[];
    readonly usage: Record<string, AccountUsage>;
    readonly moveAfterLimit?: boolean;
    readonly limitMoveCarryUnder?: number;
    readonly override?: boolean;
}): Pick<Services, "claudeStore" | "accountUsage" | "agents" | "sandboxSettings"> => ({
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...params.accounts] }),
    accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => params.usage }),
    agents: unstubbed<Services["agents"]>("agents", {
        entry: () => (params.override === undefined ? undefined : ({ id: "c", moveAfterLimit: params.override } as PersistedAgent)),
    }),
    sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
        get: async () => ({ moveAfterLimit: params.moveAfterLimit ?? false, limitMoveCarryUnder: params.limitMoveCarryUnder ?? 100_000 }) as never,
    }),
});

test("picks the emptiest sibling with room, skipping the refused, the dead and the unmeasured", async () => {
    const services = fakeServices({
        accounts: [account("spent"), account("half"), account("nearly-empty"), account("dead", { needsReauth: true }), account("unmeasured")],
        usage: { spent: reading(100), half: reading(50), "nearly-empty": reading(5), dead: reading(0) },
    });
    expect(await siblingWithRoom(services, { provider: "claude", model: undefined, refused: "spent" })).toBe("nearly-empty");
});

test("answers nothing when every other account is at the cap, and for a routed provider", async () => {
    const services = fakeServices({ accounts: [account("spent"), account("also-spent")], usage: { spent: reading(100), "also-spent": reading(100) } });
    expect(await siblingWithRoom(services, { provider: "claude", model: undefined, refused: "spent" })).toBeUndefined();
    expect(await siblingWithRoom(services, { provider: "codex", model: undefined, refused: undefined })).toBeUndefined();
});

test("books a move only under the policy, and carries only under the line", async () => {
    const accounts = [account("spent"), account("room")];
    const usage = { spent: reading(100), room: reading(10) };
    const ask = { conversationId: "c", provider: "claude" as const, model: undefined, refused: "spent", ran: true, contextTokens: 40_000 };

    expect(await bookLimitMove(fakeServices({ accounts, usage }), ask)).toBeUndefined();
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true }), ask)).toEqual({ account: "room", carry: true });
    // limitMoveCarryUnder (30_000) is below contextTokens (40_000): carries fresh, without the prior context.
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true, limitMoveCarryUnder: 30_000 }), ask)).toEqual({ account: "room", carry: false });
    // An unran turn has nothing worth carrying; an unmeasured context is not carried on a guess.
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true }), { ...ask, ran: false })).toEqual({ account: "room", carry: false });
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true }), { ...ask, contextTokens: undefined })).toEqual({ account: "room", carry: false });
    // A carry the other account already refused is not retried.
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true }), { ...ask, carryRefused: true })).toEqual({ account: "room", carry: false });
});

test("a conversation's override outranks the sandbox default", async () => {
    const accounts = [account("spent"), account("room")];
    const usage = { spent: reading(100), room: reading(10) };
    const ask = { conversationId: "c", provider: "claude" as const, model: undefined, refused: "spent", ran: false, contextTokens: undefined };
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true, override: false }), ask)).toBeUndefined();
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: false, override: true }), ask)).toEqual({ account: "room", carry: false });
});
