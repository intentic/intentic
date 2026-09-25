import type { AccountUsage, OauthAccount } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import type { SeatRefusal } from "../../runtimes/claude/claude-seats.js";
import { conversationEntry } from "../../testing.js";
import { bookLimitMove, siblingWithRoom } from "./sibling-account.js";

const account = (id: string, extra: Partial<OauthAccount> = {}): OauthAccount => ({ id, label: id, ...extra }) as OauthAccount;
const reading = (utilization: number): AccountUsage =>
    ({ windows: [{ kind: "five_hour", utilization, gates: "all" }], measuredAt: Date.now() }) as AccountUsage;

const fakeServices = (params: {
    readonly accounts: readonly OauthAccount[];
    readonly usage: Record<string, AccountUsage>;
    readonly moveAfterLimit?: boolean;
    readonly limitMoveCarryUnder?: number;
    readonly override?: boolean;
    readonly seats?: Record<string, SeatRefusal>;
}): Pick<Services, "claudeStore" | "claudeSeats" | "cliProxy" | "providerRefusals" | "accountUsage" | "agents" | "sandboxSettings"> => ({
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...params.accounts] }),
    claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => params.seats ?? {} }),
    cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {}),
    providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { read: async () => ({}) }),
    accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => params.usage }),
    agents: unstubbed<Services["agents"]>("agents", {
        entry: () =>
            params.override === undefined ? undefined : conversationEntry({ id: "c", postures: { limit: params.override ? "move" : "wait" } }),
    }),
    sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
        get: async () =>
            ({ limitPolicy: params.moveAfterLimit === true ? "move" : "wait", limitMoveCarryUnder: params.limitMoveCarryUnder ?? 100_000 }) as never,
    }),
});

test("picks the emptiest sibling with room, skipping the refused, the dead and the unmeasured", async () => {
    const services = fakeServices({
        accounts: [account("spent"), account("half"), account("nearly-empty"), account("dead", { needsReauth: true }), account("unmeasured")],
        usage: { spent: reading(100), half: reading(50), "nearly-empty": reading(5), dead: reading(0) },
    });
    expect(await siblingWithRoom(services, { provider: "claude", model: undefined, refused: "spent" })).toBe("nearly-empty");
});

test("never moves a held turn onto an idle account whose organisation refused its seat", async () => {
    // The seat mark lives outside the account record, and a seatless account reads full headroom: the emptiest meter
    // here is the one account no turn can run on.
    const services = fakeServices({
        accounts: [account("spent"), account("seatless"), account("busy")],
        usage: { spent: reading(100), seatless: reading(0), busy: reading(80) },
        seats: { seatless: { at: 1, reason: "Your organization has disabled Claude Code." } },
    });
    expect(await siblingWithRoom(services, { provider: "claude", model: undefined, refused: "spent" })).toBe("busy");
    const onlySeatless = fakeServices({
        accounts: [account("spent"), account("seatless")],
        usage: { spent: reading(100), seatless: reading(0) },
        seats: { seatless: { at: 1, reason: "Your organization has disabled Claude Code." } },
        moveAfterLimit: true,
    });
    expect(
        await bookLimitMove(onlySeatless, { conversationId: "c", provider: "claude", model: undefined, refused: "spent", ran: true, contextTokens: 1 }),
    ).toBeUndefined();
});

test("answers nothing when every other account is at the cap, and for a routed provider", async () => {
    const services = fakeServices({
        accounts: [account("spent"), account("also-spent")],
        usage: { spent: reading(100), "also-spent": reading(100) },
    });
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
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true, limitMoveCarryUnder: 30_000 }), ask)).toEqual({
        account: "room",
        carry: false,
    });
    // An unran turn has nothing worth carrying; an unmeasured context is not carried on a guess.
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true }), { ...ask, ran: false })).toEqual({
        account: "room",
        carry: false,
    });
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true }), { ...ask, contextTokens: undefined })).toEqual({
        account: "room",
        carry: false,
    });
    // A carry the other account already refused is not retried.
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true }), { ...ask, carryRefused: true })).toEqual({
        account: "room",
        carry: false,
    });
});

test("a conversation's override outranks the sandbox default", async () => {
    const accounts = [account("spent"), account("room")];
    const usage = { spent: reading(100), room: reading(10) };
    const ask = { conversationId: "c", provider: "claude" as const, model: undefined, refused: "spent", ran: false, contextTokens: undefined };
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: true, override: false }), ask)).toBeUndefined();
    expect(await bookLimitMove(fakeServices({ accounts, usage, moveAfterLimit: false, override: true }), ask)).toEqual({
        account: "room",
        carry: false,
    });
});
