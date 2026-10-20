import type { AccountUsage, UsageContradiction, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import pino from "pino";
import type { RefreshOptions } from "../headroom.js";
import { checkAnswered } from "./contradictions.js";

// An answered turn is the provider's own word on the model it ran: a reading taken before it that said the model could
// not run is marked wrong and re-read, and a reading that agrees, or is newer than the request, is left alone.

const ASKED_AT = 1_800_000_000_000;
const spentFor = (models: string[], over: Partial<UsageWindow> = {}): UsageWindow => ({
    kind: "google:3p-weekly",
    utilization: 100,
    resetsAt: ASKED_AT / 1000 + 3_600,
    gates: { models },
    ...over,
});
const reading = (windows: UsageWindow[], measuredAt = ASKED_AT - 60_000): AccountUsage => ({ windows, measuredAt });

const harness = (stored: Record<string, AccountUsage>) => {
    const written: string[] = [];
    const contradicted: { account: string; contradiction: UsageContradiction }[] = [];
    const refreshes: (RefreshOptions | undefined)[] = [];
    const deps = {
        logger: pino({ level: "info" }, { write: (line: string) => written.push(line) }),
        headroom: {
            read: async () => stored,
            contradict: async (_provider: string, account: string, contradiction: UsageContradiction, takenBefore: number) => {
                const usage = stored[account];
                if (usage === undefined || usage.measuredAt >= takenBefore) {
                    return false;
                }
                contradicted.push({ account, contradiction });
                return true;
            },
            refresh: async (options?: RefreshOptions) => void refreshes.push(options),
        },
    };
    return { deps, written, contradicted, refreshes };
};

test("a named account read spent for the model that answered is marked, said and re-read", async () => {
    const { deps, written, contradicted, refreshes } = harness({ acct: reading([spentFor(["claude"])]) });
    await checkAnswered(deps, "claude", "acct", "claude-opus-4-6-thinking", ASKED_AT);
    expect(contradicted).toEqual([{ account: "acct", contradiction: { at: expect.any(Number), model: "claude-opus-4-6-thinking" } }]);
    expect(refreshes).toEqual([{ scope: { providers: ["claude"], account: "acct" }, maxAgeMs: 0 }]);
    expect(written).toEqual([expect.stringContaining("readings said was spent")]);
});

test("a reading with room for the model, or newer than the request, is left alone", async () => {
    const roomy = harness({ acct: reading([spentFor(["claude"], { utilization: 40 })]) });
    await checkAnswered(roomy.deps, "claude", "acct", "claude-opus-4-6-thinking", ASKED_AT);
    expect(roomy.contradicted).toEqual([]);

    // Spent for another family only: the answer proves nothing about that pool.
    const other = harness({ acct: reading([spentFor(["claude", "gpt"])]) });
    await checkAnswered(other.deps, "claude", "acct", "gemini-3.8-flash-high", ASKED_AT);
    expect(other.contradicted).toEqual([]);

    const newer = harness({ acct: reading([spentFor(["claude"])], ASKED_AT + 1) });
    await checkAnswered(newer.deps, "claude", "acct", "claude-opus-4-6-thinking", ASKED_AT);
    expect(newer.contradicted).toEqual([]);
    expect(newer.refreshes).toEqual([]);
});

// A routed turn names no account: one of them served it, so the readings are wrong only once every one says none.
test("a routed answer contradicts its provider's readings only when all of them say spent", async () => {
    const mixed = harness({
        "gemini:a.json": reading([spentFor(["claude", "gpt"])]),
        "gemini:b.json": reading([spentFor(["claude", "gpt"], { utilization: 30 })]),
        "codex:c.json": reading([spentFor(["gpt"])]),
    });
    await checkAnswered(mixed.deps, "gemini", undefined, "claude-opus-4-6-thinking", ASKED_AT);
    expect(mixed.contradicted).toEqual([]);

    const allSpent = harness({ "gemini:a.json": reading([spentFor(["claude", "gpt"])]), "gemini:b.json": reading([spentFor(["claude", "gpt"])]) });
    await checkAnswered(allSpent.deps, "gemini", undefined, "claude-opus-4-6-thinking", ASKED_AT);
    expect(allSpent.contradicted.map((entry) => entry.account)).toEqual(["gemini:a.json", "gemini:b.json"]);
    expect(allSpent.refreshes).toEqual([{ scope: { providers: ["gemini"] }, maxAgeMs: 0 }]);
});

// A refusal this sandbox recorded itself is settled by the same answer on its own path; it is no reading to be wrong.
test("a check that fails is logged, never thrown into the answered turn", async () => {
    const { deps, written } = harness({});
    const failing = { ...deps, headroom: { ...deps.headroom, read: async () => { throw new Error("disk gone"); } } };
    await expect(checkAnswered(failing, "claude", "acct", "opus", ASKED_AT)).resolves.toBeUndefined();
    expect(written).toEqual([expect.stringContaining("answered-turn check")]);
});
