import type { AccountState } from "../schemas/providers/plan-limits.js";
import { moveDestination } from "./account-moves.js";

const entry = (id: string, state: AccountState, flapping?: boolean) => ({ id, state, flapping });
const SPENT: AccountState = { kind: "spent" };
const UNREAD: AccountState = { kind: "unknown" };
const SEATLESS: AccountState = { kind: "blocked", fix: "admin", reason: "no seat" };

test("proven room wins wherever the provider publishes an allowance, and nothing else does", () => {
    expect(moveDestination([entry("unread", UNREAD), entry("low", { kind: "ready", room: 5 }), entry("high", { kind: "ready", room: 60 })], true)?.id).toBe("high");
    expect(moveDestination([entry("unread", UNREAD), entry("spent", SPENT)], true)).toBeUndefined();
});

// The 2026-10-29 sandbox: a Devin account refused for its weekly quota, two connected beside it that nothing had refused.
test("a provider that publishes no allowance moves onto an account nothing has refused", () => {
    expect(moveDestination([entry("spent", SPENT), entry("second", UNREAD), entry("third", UNREAD)], false)?.id).toBe("second");
    expect(moveDestination([entry("flapping", UNREAD, true), entry("steady", UNREAD)], false)?.id).toBe("steady");
});

test("never onto a spent, blocked or at-the-line account, whatever the provider publishes", () => {
    for (const readable of [true, false]) {
        expect(moveDestination([entry("spent", SPENT), entry("seatless", SEATLESS), entry("line", { kind: "ready", room: 0 })], readable)).toBeUndefined();
    }
});
