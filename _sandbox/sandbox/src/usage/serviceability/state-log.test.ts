import type { AccountState, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { type ServiceFacts, serviceStates } from "@intentic/sandbox-contract/models/plan-pools";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import { createAccountStateLog } from "./state-log.js";

// The verdict on an account was computed on every read and logged nowhere; an agent had to call the provider's usage API
// by hand to learn a weekly pool sat at 100. One line per change, with the reading that decided it.

const NOW = 1_800_000_000_000;
const weekly = (utilization: number, extra: { rounded?: boolean } = {}): ServiceFacts["usage"] => ({
    windows: [{ kind: "seven_day", utilization, gates: "all", resetsAt: 1_800_100_000, ...extra }],
    measuredAt: NOW - 1_000,
});

const judge = (facts: readonly ServiceFacts[], refusals?: readonly ProviderRefusal[]): ReadonlyMap<string, AccountState> => serviceStates(facts, refusals, undefined, NOW);

test("writes one line per change of verdict, naming the account by its label and the pool that decided it", () => {
    const { lines, logger } = recordingLogger();
    const log = createAccountStateLog(logger, () => NOW);
    const ready = [{ account: "uuid-1", label: "rkrohmorath", usage: weekly(40) }];
    log.note("claude", ready, judge(ready), undefined);
    log.note("claude", ready, judge(ready), undefined);
    const spent = [{ account: "uuid-1", label: "rkrohmorath", usage: weekly(100) }];
    log.note("claude", spent, judge(spent), undefined);
    log.note("claude", spent, judge(spent), undefined);
    // A first sight of an account that can serve is no news; becoming spent is, once.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
        level: "info",
        message: "accounts: claude account rkrohmorath ready → spent",
        provider: "claude",
        account: "uuid-1",
        label: "rkrohmorath",
        window: "seven_day",
        utilization: 100,
        reopensAt: new Date(1_800_100_000 * 1000).toISOString(),
    });
});

test("a rounded pool read at 100 is at the line, not spent, and a standing refusal is named as the cause", () => {
    const { lines, logger } = recordingLogger();
    const log = createAccountStateLog(logger, () => NOW);
    const atLine = [{ account: "a", usage: weekly(100, { rounded: true }) }];
    log.note("claude", atLine, judge(atLine), undefined);
    const refusal: ProviderRefusal = { at: NOW - 500, kind: "limit", message: "usage limit reached", account: "a" };
    log.note("claude", atLine, judge(atLine, [refusal]), [refusal]);
    expect(lines.map((line) => line["message"])).toEqual(["accounts: claude account a unseen → ready (at the line)", "accounts: claude account a ready (at the line) → spent"]);
    expect(lines[0]).toMatchObject({ rounded: true, utilization: 100 });
    expect(lines[1]).toMatchObject({ refusal: { kind: "limit", message: "usage limit reached" } });
});

test("judgements scoped to different models are tracked apart", () => {
    const { lines, logger } = recordingLogger();
    const log = createAccountStateLog(logger, () => NOW);
    const facts = [{ account: "a", usage: weekly(100) }];
    log.note("claude", facts, judge(facts), undefined);
    log.note("claude", facts, serviceStates(facts, undefined, { id: "claude-opus-5-5" }, NOW), undefined, { id: "claude-opus-5-5" });
    expect(lines.map((line) => line["model"])).toEqual([undefined, "claude-opus-5-5"]);
});
