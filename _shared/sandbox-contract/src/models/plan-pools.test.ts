import {
    answerCovers,
    bindingWindow,
    currentWindows,
    gatesModel,
    gatingWindows,
    judgedReading,
    fleetCapacity,
    readingHeadroom,
    preferredAccount,
    refusalVerdict,
    refusedPoolReset,
    roomiestAccount,
    scopedWindow,
    uncoveredModels,
    serviceState,
    serviceStates,
    windowLive,
    windowPeriod,
} from "./plan-pools.js";
import type { AccountState, AccountUsage, ProviderRefusal, UsageWindow } from "../schemas/providers/plan-limits.js";

// One rule for which pool blocks a given model, shared by the daemon and the browser: a plan can meter models
// separately, so the account's fullest pool need not be the model's own.

const window = (over: Partial<UsageWindow> & Pick<UsageWindow, "kind">): UsageWindow => ({ utilization: 10, gates: "all", ...over });
const usage = (...windows: UsageWindow[]): AccountUsage => ({ windows, measuredAt: 0 });

const GOOGLE = usage(
    window({ kind: "google:gemini-weekly", label: "Gemini models", utilization: 100, gates: { models: ["gemini"] } }),
    window({ kind: "google:3p-weekly", label: "Claude and GPT models", utilization: 27, gates: { models: ["claude", "gpt"] } }),
);

const CLAUDE = usage(
    window({ kind: "five_hour", utilization: 12 }),
    window({ kind: "seven_day", utilization: 30 }),
    window({ kind: "model:Opus", label: "Opus", utilization: 100, gates: { models: ["Opus"] } }),
    window({ kind: "surface:Cowork", label: "Cowork", utilization: 99, gates: "none" }),
);

test("matches a pool's names as runs of whole words against the id and the label alike", () => {
    expect(gatesModel({ models: ["opus"] }, { id: "claude-opus-4-6" })).toBe(true);
    expect(gatesModel({ models: ["Opus"] }, { id: "some-id", label: "Claude Opus 4.6" })).toBe(true);
    expect(gatesModel({ models: ["son"] }, { id: "claude-sonnet-4-6" })).toBe(false);
    expect(gatesModel({ models: ["claude opus"] }, { id: "claude-opus-4-6" })).toBe(true);
    expect(gatesModel({ models: ["opus claude"] }, { id: "claude-opus-4-6" })).toBe(false);
    expect(gatesModel("all", { id: "anything" })).toBe(true);
    expect(gatesModel("none", { id: "anything" })).toBe(false);
});

test("a Google account spent for Gemini still has room for Claude Opus, and the other way round", () => {
    // One account, two independently metered pools (Gemini vs Claude/GPT), each on its own clock.
    expect(bindingWindow(GOOGLE, { id: "claude-opus-4-6-thinking" })?.kind).toBe("google:3p-weekly");
    expect(bindingWindow(GOOGLE, { id: "gpt-oss-120b" })?.kind).toBe("google:3p-weekly");
    expect(bindingWindow(GOOGLE, { id: "gemini-3-pro" })?.kind).toBe("google:gemini-weekly");
    // A model family with no published pool is unmeasured, not blocked.
    expect(bindingWindow(GOOGLE, { id: "kimi-k2" })).toBeUndefined();
});

test("a Claude account's spent Opus slice does not bind a Haiku call, and its own 5-hour and weekly pools do", () => {
    expect(gatingWindows(CLAUDE, { id: "claude-haiku-4-5" }).map((entry) => entry.kind)).toEqual(["five_hour", "seven_day"]);
    expect(bindingWindow(CLAUDE, { id: "claude-haiku-4-5" })?.kind).toBe("seven_day");
    expect(bindingWindow(CLAUDE, { id: "claude-opus-4-6" })?.kind).toBe("model:Opus");
});

test("with no model named, the account's tightest pool is the answer, and a pool gating nothing is never it", () => {
    expect(bindingWindow(CLAUDE)?.kind).toBe("model:Opus");
    expect(gatingWindows(CLAUDE).map((entry) => entry.kind)).toEqual(["five_hour", "seven_day", "model:Opus"]);
    expect(bindingWindow(undefined)).toBeUndefined();
    expect(bindingWindow(usage())).toBeUndefined();
});

test("names the pool a plan meters this model by on its own, preferring the more specific and refusing a tie", () => {
    expect(scopedWindow(CLAUDE, { id: "claude-opus-4-6" })?.kind).toBe("model:Opus");
    // five_hour and seven_day meter all models, not just this one; scopedWindow needs a model-specific pool.
    expect(scopedWindow(CLAUDE, { id: "claude-haiku-4-5" })).toBeUndefined();
    const layered = usage(
        window({ kind: "model:Opus", gates: { models: ["Opus"] } }),
        window({ kind: "model:Claude Opus", gates: { models: ["Claude Opus"] } }),
    );
    expect(scopedWindow(layered, { id: "claude-opus-4-6" })?.kind).toBe("model:Claude Opus");
    const tied = usage(window({ kind: "model:Opus", gates: { models: ["Opus"] } }), window({ kind: "model:Claude", gates: { models: ["Claude"] } }));
    expect(scopedWindow(tied, { id: "claude-opus-4-6" })).toBeUndefined();
});

// How long a pool's window runs, read off the provider's own key and name. Two things turn on it, which is why it is
// one function: a narrow column names the window by `short`, and a reading with no published reset may only be trusted
// for that long.

test("a window's length is read off the provider's own key, and off its name where the key says nothing", () => {
    const period = (kind: string, label?: string) => windowPeriod(label === undefined ? { kind } : { kind, label });
    expect(period("five_hour")).toEqual({ seconds: 5 * 3_600, short: "5h" });
    expect(period("seven_day")).toEqual({ seconds: 7 * 86_400, short: "wk" });
    expect(period("seven_day_opus")).toEqual({ seconds: 7 * 86_400, short: "wk" });
    // Anthropic's own key says nothing; the label the reader built from it does.
    expect(period("model:Fable", "Weekly · Fable")).toEqual({ seconds: 7 * 86_400, short: "wk" });
    expect(period("google:gemini-weekly", "Gemini Models · Weekly Limit Remaining")).toEqual({ seconds: 7 * 86_400, short: "wk" });
    expect(period("monthly", "Monthly · all models")).toEqual({ seconds: 30 * 86_400, short: "mo" });
    expect(period("claude:12_hour")).toEqual({ seconds: 12 * 3_600, short: "12h" });
    expect(period("daily")).toEqual({ seconds: 86_400, short: "24h" });
    expect(period("30_minutes")).toEqual({ seconds: 1_800, short: "30m" });
    // A pool nothing names the length of answers nothing, rather than guessing one.
    expect(period("claude:tangelo")).toBeUndefined();
    expect(period("model:Fable", "Fable")).toBeUndefined();
});

test("a reading is live until its reset, or, with none published, for one window's length after it was taken", () => {
    const NOW = 1_700_000_000_000;
    const HOUR = 3_600_000;
    // A published reset is the authority whatever the window's length says, in both directions.
    expect(windowLive(window({ kind: "five_hour", resetsAt: NOW / 1_000 + 60 }), NOW - 50 * HOUR, NOW)).toBe(true);
    expect(windowLive(window({ kind: "seven_day", resetsAt: NOW / 1_000 - 1 }), NOW, NOW)).toBe(false);

    // With none — what an idle five-hour pool is published with — the window's own length retires it.
    const idle = window({ kind: "five_hour", utilization: 0 });
    expect(windowLive(idle, NOW - 4 * HOUR, NOW)).toBe(true);
    expect(windowLive(idle, NOW - 6 * HOUR, NOW)).toBe(false);
    // A weekly pool read on the same morning is still describing the week it was read in.
    expect(windowLive(window({ kind: "seven_day", utilization: 78 }), NOW - 12 * HOUR, NOW)).toBe(true);

    // And a pool whose length nothing names has only its reset instant; without one it stands.
    expect(windowLive(window({ kind: "claude:tangelo" }), NOW - 400 * HOUR, NOW)).toBe(true);
});

test("a pool whose window closed since its reading stays on the account, at the floor and marked lapsed, not dropped", () => {
    const NOW = 1_700_000_000_000;
    const HOUR = 3_600_000;
    // The case that lost the five-hour row: re-reads failing for hours, the weekly pools still current.
    const stale: AccountUsage = {
        measuredAt: NOW - 8 * HOUR,
        windows: [
            window({ kind: "five_hour", utilization: 63, resetsAt: (NOW - 5 * HOUR) / 1_000, rounded: true }),
            window({ kind: "seven_day", utilization: 42, resetsAt: NOW / 1_000 + 100 * 3_600 }),
            window({ kind: "model:Fable", label: "Fable", utilization: 0, resetsAt: NOW / 1_000 + 100 * 3_600, gates: { models: ["Fable"] } }),
        ],
    };
    const current = currentWindows(stale, NOW);
    expect(current.map((pool) => pool.kind)).toEqual(["five_hour", "seven_day", "model:Fable"]);
    expect(current[0]).toEqual({ kind: "five_hour", utilization: 0, gates: "all", lapsedAt: (NOW - 5 * HOUR) / 1_000 });
    expect(current.slice(1)).toEqual(stale.windows.slice(1));
    // The floor binds nothing: the weekly pool is still the one that gates the next turn.
    expect(bindingWindow({ ...stale, windows: current })?.kind).toBe("seven_day");
    // Applying it again changes nothing, so a surface may run it over rows the daemon already ran it over.
    expect(currentWindows({ ...stale, windows: current }, NOW)).toEqual(current);

    // An idle pool published with no reset lapses at the end of its own length.
    const idle: AccountUsage = {
        measuredAt: NOW - 6 * HOUR,
        windows: [window({ kind: "five_hour", utilization: 0 }), window({ kind: "seven_day", utilization: 5, resetsAt: NOW / 1_000 + 3_600 })],
    };
    expect(currentWindows(idle, NOW)[0]?.lapsedAt).toBe((NOW - HOUR) / 1_000);

    // A reading with nothing current left says nothing about now: the account reads as unmeasured.
    expect(currentWindows({ measuredAt: NOW - 8 * HOUR, windows: stale.windows.slice(0, 1) }, NOW)).toEqual([]);
});

// Serviceability: the one verdict on whether an account can serve a turn.

const at = (measuredAt: number, ...windows: UsageWindow[]): AccountUsage => ({ windows, measuredAt });
const refusal = (over: Partial<ProviderRefusal> & Pick<ProviderRefusal, "kind">): ProviderRefusal => ({ at: 1_000, message: "no.", ...over });

test("spent is the contract's one line: 99.5% still has room, 100% is spent until its last full pool reopens", () => {
    expect(readingHeadroom(usage(window({ kind: "five_hour", utilization: 99.5 })))).toEqual({ kind: "ready", room: 0.5 });
    expect(
        readingHeadroom(usage(window({ kind: "five_hour", utilization: 100, resetsAt: 50 }), window({ kind: "seven_day", utilization: 100, resetsAt: 900 }))),
    ).toEqual({ kind: "spent", reopensAt: 900 });
    expect(readingHeadroom(usage(window({ kind: "five_hour", utilization: 100 })))).toEqual({ kind: "spent" });
    expect(readingHeadroom(undefined)).toEqual({ kind: "unknown" });
    expect(readingHeadroom(CLAUDE, { id: "claude-haiku-4-5" })).toEqual({ kind: "ready", room: 70 });
    expect(readingHeadroom(CLAUDE, { id: "claude-opus-4-6" })).toEqual({ kind: "spent", pool: "Opus" });
});

// Anthropic reports whole percents: an account read at 100 kept serving turns for hours, so that reading is the line,
// not proof. Only the provider's refusal makes such a pool spent.
test("a pool read at 100 in whole percents is at the line with no room, until a refusal proves it empty", () => {
    const week = window({ kind: "seven_day", utilization: 100, resetsAt: 900, rounded: true });
    const atLine = usage(window({ kind: "five_hour", utilization: 75, rounded: true }), week);
    expect(readingHeadroom(atLine)).toEqual({ kind: "ready", room: 0 });
    expect(readingHeadroom(atLine, { id: "claude-opus-5-5" })).toEqual({ kind: "ready", room: 0 });
    // A precise 100 is still spent.
    expect(readingHeadroom(usage(window({ kind: "seven_day", utilization: 100, resetsAt: 900 })))).toEqual({ kind: "spent", reopensAt: 900 });
    // The provider refused it: spent until the pool reopens, and a reading still at the line does not answer that.
    const facts = { account: "a", usage: { ...atLine, measuredAt: 2_000 } };
    const refused = refusal({ kind: "limit", account: "a" });
    expect(refusalVerdict(refused, [facts])).toBe("standing");
    expect(serviceStates([facts], [refused]).get("a")).toEqual({ kind: "spent", reopensAt: 900 });
});

test("with no model named, an account is spent only when no model can run on it", () => {
    // A full Opus slice leaves every other model the room of the fullest pool still open.
    expect(readingHeadroom(CLAUDE)).toEqual({ kind: "ready", room: 70 });
    expect(readingHeadroom(GOOGLE)).toEqual({ kind: "ready", room: 73 });
    // A pool gating every model, full: nothing runs, and it reopens with that pool.
    expect(readingHeadroom(usage(window({ kind: "seven_day", utilization: 100, resetsAt: 900 }), window({ kind: "model:Opus", utilization: 10, gates: { models: ["Opus"] } })))).toEqual({
        kind: "spent",
        reopensAt: 900,
    });
    // Every slice full: the first to reopen lets some model run again.
    expect(
        readingHeadroom(
            usage(
                window({ kind: "g", utilization: 100, resetsAt: 500, gates: { models: ["gemini"] } }),
                window({ kind: "c", utilization: 100, resetsAt: 800, gates: { models: ["claude"] } }),
            ),
        ),
    ).toEqual({ kind: "spent", reopensAt: 500 });
});

test("a revoked sign-in outranks a lost seat, which outranks a bench, whatever the meters say", () => {
    const facts = { account: "a", usage: usage(window({ kind: "five_hour", utilization: 0 })) };
    expect(serviceState({ ...facts, needsReauth: true, seatRefusal: "no seat" })).toEqual({ kind: "blocked", fix: "reconnect", reason: "sign-in expired" });
    expect(serviceState({ ...facts, seatRefusal: "Your org disabled Claude Code." })).toEqual({
        kind: "blocked",
        fix: "admin",
        reason: "Your org disabled Claude Code.",
    });
    expect(serviceState({ ...facts, cooling: { reason: "no project" } })).toEqual({ kind: "blocked", fix: "reconnect", reason: "no project" });
    expect(serviceState({ ...facts, cooling: { until: 2_000 } }, undefined, undefined, 1_000_000)).toEqual({
        kind: "blocked",
        fix: "wait",
        reason: "cooling down",
        until: 2_000,
    });
    // One Google wants its owner to verify: neither waiting nor reconnecting lifts it, and the row carries the page.
    expect(serviceState({ ...facts, cooling: { reason: "Verify your account to continue.", verify: "https://accounts.google.com/v" } })).toEqual({
        kind: "blocked",
        fix: "verify",
        reason: "Verify your account to continue.",
        url: "https://accounts.google.com/v",
    });
    // A bench whose instant has passed is over.
    expect(serviceState({ ...facts, cooling: { until: 999 } }, undefined, undefined, 1_000_000)).toEqual({ kind: "ready", room: 100 });
});

test("a standing refusal blocks by its kind, and a limit refusal pins only the pool its model spends", () => {
    const facts = { account: "a", usage: CLAUDE };
    expect(serviceState(facts, [refusal({ kind: "auth" })])).toEqual({ kind: "blocked", fix: "reconnect", reason: "no." });
    expect(serviceState(facts, [refusal({ kind: "entitlement" })])).toEqual({ kind: "blocked", fix: "admin", reason: "no." });
    // Refused on Haiku: the 5-hour/weekly binding pool (seven_day, 30%) reads full, so Haiku is spent too.
    expect(serviceState(facts, [refusal({ kind: "limit", model: "claude-haiku-4-5" })], { id: "claude-haiku-4-5" })).toEqual({ kind: "spent" });
    // Refused on Opus: its own slice was already full; Haiku keeps the room its pools show.
    expect(serviceState(facts, [refusal({ kind: "limit", model: "claude-opus-4-6" })], { id: "claude-haiku-4-5" })).toEqual({ kind: "ready", room: 70 });
    // No reading at all: the refusal is the evidence, unless it was about another model.
    expect(serviceState({ account: "a" }, [refusal({ kind: "limit" })])).toEqual({ kind: "spent" });
    expect(serviceState({ account: "a" }, [refusal({ kind: "limit", model: "opus" })], { id: "haiku" })).toEqual({ kind: "unknown" });
});

test("a refusal stands until a later reading contradicts it, and never past its account's disconnection", () => {
    const room = at(2_000, window({ kind: "five_hour", utilization: 40 }));
    const full = at(2_000, window({ kind: "five_hour", utilization: 100 }));
    const before = at(500, window({ kind: "five_hour", utilization: 40 }));
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [{ account: "a", usage: room }])).toBe("answered");
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [{ account: "a", usage: full }])).toBe("standing");
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [{ account: "a", usage: before }])).toBe("standing");
    // Another account's room proves nothing about the one refused.
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [{ account: "a", usage: before }, { account: "b", usage: room }])).toBe("standing");
    // A refusal naming no account is answered by any of them.
    expect(refusalVerdict(refusal({ kind: "limit" }), [{ account: "a", usage: before }, { account: "b", usage: room }])).toBe("answered");
    expect(refusalVerdict(refusal({ kind: "auth", account: "a" }), [{ account: "a", usage: full }])).toBe("answered");
    expect(refusalVerdict(refusal({ kind: "auth", account: "a" }), [{ account: "a", usage: full, needsReauth: true }])).toBe("standing");
    expect(refusalVerdict(refusal({ kind: "entitlement", account: "a" }), [{ account: "a", usage: room }])).toBe("standing");
    expect(refusalVerdict(refusal({ kind: "limit", account: "gone" }), [{ account: "a", usage: room }])).toBe("gone");
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [])).toBe("standing");
});

// An admin's allowance (Cursor's team spend limit) is one the refused account's own reading does not measure.
test("an allowance no reading measures stands against its own account's reading, until the provider's own reset", () => {
    const room = at(Date.now() + 60_000, window({ kind: "seven_day", utilization: 43 }));
    const credit = refusal({ kind: "limit", unmetered: true, at: Date.now(), resetsAt: Math.floor(Date.now() / 1000) + 3_600 });
    expect(refusalVerdict({ ...credit, account: "a" }, [{ account: "a", usage: room }, { account: "b", usage: room }])).toBe("standing");
    expect(refusalVerdict(credit, [{ account: "a", usage: room }])).toBe("standing");
    expect(refusalVerdict({ ...credit, account: "a", resetsAt: Math.floor(Date.now() / 1000) - 1 }, [{ account: "a", usage: room }])).toBe("answered");
    expect(refusalVerdict({ ...credit, resetsAt: undefined }, [{ account: "a", usage: room }])).toBe("standing");
});

// 2026-10-19: one routed refusal ("try again at 1:53 PM", filed a day out, as an admin's credit) named no account and
// held all three Codex accounts spent for that day, two free ones reading 0% of their month used among them.
test("a nameless refusal over several accounts is answered by any of them reading room since, whatever it named", () => {
    const filed = Date.parse("2026-10-19T13:53:35Z");
    const now = Date.parse("2026-10-20T09:22:10Z");
    const monthly = at(Date.parse("2026-10-20T09:22:03Z"), window({ kind: "monthly", label: "Monthly · all models", utilization: 0 }));
    const fiveHour = at(Date.parse("2026-10-20T09:22:03Z"), window({ kind: "five_hour", utilization: 0 }), window({ kind: "seven_day", utilization: 0 }));
    const accounts = [
        { account: "free-1", usage: monthly },
        { account: "free-2", usage: monthly },
        { account: "team", usage: fiveHour },
    ];
    const codex = refusal({ kind: "limit", at: filed, model: "gpt-6.1-sol", resetsAt: Date.parse("2026-10-20T13:53:00Z") / 1000, unmetered: true });
    expect(refusalVerdict(codex, accounts, now)).toBe("answered");
    expect(Object.fromEntries(serviceStates(accounts, [codex], undefined, now))).toEqual({
        "free-1": { kind: "ready", room: 100 },
        "free-2": { kind: "ready", room: 100 },
        team: { kind: "ready", room: 100 },
    });
    // Until one of them is read with room after it, it stands over all of them.
    const before = accounts.map((entry) => ({ ...entry, usage: { ...entry.usage, measuredAt: filed - 1 } }));
    expect(refusalVerdict(codex, before, now)).toBe("standing");
    // And never past the instant the provider named.
    expect(refusalVerdict(codex, before, Date.parse("2026-10-20T13:53:00Z"))).toBe("answered");
});


// Codex's usage endpoint kept reading room while every turn was refused "try again at 3:38 PM": the provider's own
// instant is what ends the refusal, where it is known which account it refused.
test("a spent allowance with the provider's own reset stands until that instant, whatever a later reading says", () => {
    const room = at(2_000, window({ kind: "five_hour", utilization: 0 }));
    const until = { kind: "limit", resetsAt: 10 } as const;
    expect(refusalVerdict(refusal({ ...until, account: "a" }), [{ account: "a", usage: room }], 9_999)).toBe("standing");
    expect(refusalVerdict(refusal({ ...until, account: "a" }), [{ account: "a", usage: room }], 10_000)).toBe("answered");
    // A routed refusal names no account, but with one account there is no doubt whose it was.
    expect(refusalVerdict(refusal(until), [{ account: "a", usage: room }], 9_999)).toBe("standing");
    // Over several, the translator benches the one it refused and routes on, so another's room still answers it.
    expect(refusalVerdict(refusal(until), [{ account: "a", usage: room }, { account: "b", usage: room }], 9_999)).toBe("answered");
    // Spent until the instant the provider named, not the pool's own reset.
    expect(serviceStates([{ account: "a", usage: room }], [refusal({ ...until, account: "a" })], undefined, 9_999).get("a")).toEqual({ kind: "spent", reopensAt: 10 });
});

// 2026-10-20: a spent allowance the provider gave no instant for stood past the reset of the pool it was refused in, the
// "back at" every surface showed, until the next reading landed (up to the daemon's 15-minute idle sweep).
test("a spent allowance with no instant named is stamped with its pool's reset, and ends there everywhere at once", () => {
    const reset = 10;
    const filling = at(500, window({ kind: "five_hour", utilization: 96, resetsAt: reset }), window({ kind: "seven_day", utilization: 40, resetsAt: 900 }));
    const accounts = [{ account: "a", usage: filling }];
    const spent = refusal({ kind: "limit", account: "a", model: "gpt-6.1-sol" });
    expect(refusedPoolReset(spent, accounts)).toBe(reset);
    const filed = { ...spent, poolResetsAt: reset };
    expect(refusalVerdict(filed, accounts, reset * 1000 - 1)).toBe("standing");
    expect(serviceStates(accounts, [filed], undefined, reset * 1000 - 1).get("a")).toEqual({ kind: "spent", reopensAt: reset });
    expect(refusalVerdict(filed, accounts, reset * 1000)).toBe("answered");
    // Even once the reading has lapsed that pool, so the weekly one binds: the stamp, not the reading, says when.
    const lapsed = at(500, window({ kind: "five_hour", utilization: 0, lapsedAt: reset }), window({ kind: "seven_day", utilization: 40, resetsAt: 900 }));
    expect(refusedPoolReset(spent, [{ account: "a", usage: lapsed }])).toBe(900);
    expect(refusalVerdict(filed, [{ account: "a", usage: lapsed }], reset * 1000)).toBe("answered");
    expect(serviceStates([{ account: "a", usage: lapsed }], [filed], undefined, reset * 1000).get("a")).toEqual({ kind: "ready", room: 60 });
});

test("the stamp is the refused account's pool, or the soonest of any where the refusal named none", () => {
    const soon = at(500, window({ kind: "five_hour", utilization: 96, resetsAt: 10 }));
    const later = at(500, window({ kind: "five_hour", utilization: 96, resetsAt: 50 }));
    const accounts = [{ account: "b", usage: later }, { account: "a", usage: soon }];
    expect(refusedPoolReset(refusal({ kind: "limit" }), accounts)).toBe(10);
    expect(refusedPoolReset(refusal({ kind: "limit", account: "b" }), accounts)).toBe(50);
    // The pool the model spends, not the account's fullest.
    const opus = at(500, window({ kind: "five_hour", utilization: 20, resetsAt: 10 }), window({ kind: "model:Opus", label: "Opus", utilization: 99, resetsAt: 70, gates: { models: ["Opus"] } }));
    expect(refusedPoolReset(refusal({ kind: "limit", model: "claude-opus-4-6" }), [{ account: "a", usage: opus }])).toBe(70);
    expect(refusedPoolReset(refusal({ kind: "limit", model: "claude-haiku-4-5" }), [{ account: "a", usage: opus }])).toBe(10);
});

test("nothing is stamped where a pool's reset cannot speak for the refusal", () => {
    const reopening = at(500, window({ kind: "five_hour", utilization: 96, resetsAt: 10 }));
    // A reading older than the window it was refused in: that reset was over before the refusal came.
    expect(refusedPoolReset(refusal({ kind: "limit", at: 20_000 }), [{ account: "a", usage: reopening }])).toBeUndefined();
    expect(refusedPoolReset(refusal({ kind: "limit" }), [{ account: "a", usage: at(500, window({ kind: "monthly", utilization: 96 })) }])).toBeUndefined();
    expect(refusedPoolReset(refusal({ kind: "limit" }), [{ account: "a" }])).toBeUndefined();
    expect(refusedPoolReset(refusal({ kind: "limit", account: "gone" }), [{ account: "a", usage: reopening }])).toBeUndefined();
    // The provider's own instant, an allowance no reading measures, a person's mark, and any refusal but a spent allowance.
    expect(refusedPoolReset(refusal({ kind: "limit", resetsAt: 5 }), [{ account: "a", usage: reopening }])).toBeUndefined();
    expect(refusedPoolReset(refusal({ kind: "limit", unmetered: true }), [{ account: "a", usage: reopening }])).toBeUndefined();
    expect(refusedPoolReset(refusal({ kind: "limit", byHand: true }), [{ account: "a", usage: reopening }])).toBeUndefined();
    expect(refusedPoolReset(refusal({ kind: "entitlement" }), [{ account: "a", usage: reopening }])).toBeUndefined();
    // And a refusal filed unstamped keeps standing until a reading answers it, as before.
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [{ account: "a", usage: reopening }], 9e12)).toBe("standing");
});

test("a provider's accounts are judged together: a standing refusal lands only on the account it names", () => {
    const room = at(500, window({ kind: "five_hour", utilization: 40 }));
    const states = serviceStates([{ account: "a", usage: room }, { account: "b", usage: room }], [refusal({ kind: "entitlement", account: "a" })]);
    expect(Object.fromEntries(states)).toEqual({ a: { kind: "blocked", fix: "admin", reason: "no." }, b: { kind: "ready", room: 60 } });
    const answered = serviceStates([{ account: "a", usage: at(2_000, window({ kind: "five_hour", utilization: 40 })) }], [refusal({ kind: "limit", account: "a" })]);
    expect(answered.get("a")).toEqual({ kind: "ready", room: 60 });
});

// The provider's last refusal moves on to whichever account says no next; an account's own refusal on file stays true of
// it. A pool Anthropic reads at a rounded 100 is only proven empty by that refusal.
test("each account answers to the newest refusal on file that still stands over it", () => {
    const line = at(5_000, window({ kind: "seven_day", utilization: 100, rounded: true, resetsAt: 20 }));
    // Read before its sign-in was refused, so nothing has answered that refusal yet.
    const room = at(2_000, window({ kind: "seven_day", utilization: 30 }));
    const own = refusal({ kind: "limit", account: "a", resetsAt: 20, at: 1_000 });
    const elsewhere = refusal({ kind: "auth", account: "b", at: 3_000 });
    const accounts = [
        { account: "a", usage: line },
        { account: "b", usage: room },
    ];
    expect(Object.fromEntries(serviceStates(accounts, [elsewhere, own], undefined, 9_999))).toEqual({
        a: { kind: "spent", reopensAt: 20 },
        b: { kind: "blocked", fix: "reconnect", reason: "no." },
    });
    // Only the provider's last one: the first account is back at the line, no room but not proven spent.
    expect(serviceStates(accounts, [elsewhere], undefined, 9_999).get("a")).toEqual({ kind: "ready", room: 0 });
    // Past the instant the provider named, its refusal is over and the reading speaks alone.
    expect(serviceStates(accounts, [elsewhere, own], undefined, 20_000).get("a")).toEqual({ kind: "ready", room: 0 });
    // A newer refusal on the same account outranks the older one.
    const revoked = refusal({ kind: "auth", account: "a", at: 6_000 });
    expect(serviceStates(accounts, [own, revoked], undefined, 9_999).get("a")).toEqual({ kind: "blocked", fix: "reconnect", reason: "no." });
});

test("an unnamed turn takes the most room, then an unmeasured account, then a spent one, and a blocked one only when that is all", () => {
    const entry = (id: string, state: AccountState) => ({ id, state });
    const blocked: AccountState = { kind: "blocked", fix: "admin", reason: "no seat" };
    expect(preferredAccount([entry("seatless", blocked), entry("spent", { kind: "spent" }), entry("low", { kind: "ready", room: 5 }), entry("high", { kind: "ready", room: 60 })])?.id).toBe("high");
    expect(preferredAccount([entry("seatless", blocked), entry("spent", { kind: "spent" }), entry("unread", { kind: "unknown" })])?.id).toBe("unread");
    expect(preferredAccount([entry("seatless", blocked), entry("spent", { kind: "spent" })])?.id).toBe("spent");
    expect(preferredAccount([entry("seatless", blocked), entry("other", blocked)])?.id).toBe("seatless");
    expect(preferredAccount([entry("first", { kind: "ready", room: 60 }), entry("second", { kind: "ready", room: 60 })])?.id).toBe("first");
    expect(roomiestAccount([entry("seatless", blocked), entry("unread", { kind: "unknown" })])).toBeUndefined();
    expect(roomiestAccount([entry("low", { kind: "ready", room: 5 }), entry("high", { kind: "ready", room: 60 })])?.id).toBe("high");
});

test("an account at the line is tried after an unmeasured one and before a spent one, and never a move's destination", () => {
    const entry = (id: string, state: AccountState) => ({ id, state });
    const atLine: AccountState = { kind: "ready", room: 0 };
    expect(preferredAccount([entry("line", atLine), entry("low", { kind: "ready", room: 2 })])?.id).toBe("low");
    expect(preferredAccount([entry("line", atLine), entry("unread", { kind: "unknown" })])?.id).toBe("unread");
    expect(preferredAccount([entry("spent", { kind: "spent" }), entry("line", atLine)])?.id).toBe("line");
    // A move lands only on proven room: two accounts at the line would otherwise hand a refused turn back and forth.
    expect(roomiestAccount([entry("line", atLine), entry("spent", { kind: "spent" })])).toBeUndefined();
    expect(roomiestAccount([entry("line", atLine), entry("low", { kind: "ready", room: 2 })])?.id).toBe("low");
});

// A reading covers what its pools gate, and nothing more: a model no pool names is unknown, never covered by the rest.
test("names the served models no pool covers, and none when a pool gates every model", () => {
    const sliced = usage(window({ kind: "google:3p-weekly", utilization: 100, gates: { models: ["claude", "gpt"] } }));
    expect(uncoveredModels(sliced.windows, [{ id: "claude-opus-4-6-thinking" }, { id: "gemini-3.8-flash-high" }, { id: "gpt-oss-120b-medium" }])).toEqual([
        "gemini-3.8-flash-high",
    ]);
    expect(uncoveredModels([window({ kind: "five_hour" })], [{ id: "opus" }, { id: "sonnet" }])).toEqual([]);
    // A pool gated `none` is shown, never a cover.
    expect(uncoveredModels([window({ kind: "surface:web", gates: "none" })], [{ id: "opus" }])).toEqual(["opus"]);
});

// 2026-10-19: Google's summary stopped naming the Gemini pool, and every account read spent off its full Claude pool
// while its Gemini models served.
test("an account whose only named pools are full, with models no pool covers, is unknown rather than spent", () => {
    const thirdPartySpent = window({ kind: "google:3p-weekly", utilization: 100, resetsAt: 9_000, gates: { models: ["claude", "gpt"] } });
    expect(readingHeadroom({ ...usage(thirdPartySpent), uncovered: ["gemini-3.8-flash-high"] })).toEqual({ kind: "unknown" });
    // Without the gap it is the spent account it always was, and a model the full pool gates is spent either way.
    expect(readingHeadroom(usage(thirdPartySpent))).toEqual({ kind: "spent", reopensAt: 9_000 });
    expect(readingHeadroom({ ...usage(thirdPartySpent), uncovered: ["gemini-3.8-flash-high"] }, { id: "claude-opus-4-6-thinking" })).toEqual({
        kind: "spent",
        reopensAt: 9_000,
    });
    // A full pool gating every model still holds every model, covered or not.
    expect(readingHeadroom({ ...usage(window({ kind: "seven_day", utilization: 100, resetsAt: 7_000 })), uncovered: ["x"] })).toEqual({
        kind: "spent",
        reopensAt: 7_000,
    });
});

test("a reading contradicted by an answered turn holds that model's full pools at the line, not spent", () => {
    const full = usage(window({ kind: "google:gemini-weekly", utilization: 100, resetsAt: 9_000, gates: { models: ["gemini"] } }));
    const contradicted: AccountUsage = { ...full, contradicted: { at: 1, model: "gemini-3.8-flash-high" } };
    expect(readingHeadroom(contradicted, { id: "gemini-3.8-flash-high" })).toEqual({ kind: "ready", room: 0 });
    expect(readingHeadroom(contradicted)).toEqual({ kind: "ready", room: 0 });
    // Another family's pool is not what the turn proved anything about.
    const other: AccountUsage = { ...full, contradicted: { at: 1, model: "claude-opus-4-6-thinking" } };
    expect(readingHeadroom(other, { id: "gemini-3.8-flash-high" })).toEqual({ kind: "spent", reopensAt: 9_000 });
});

test("a pool the provider stopped reporting is dropped once its window closes, not kept at a floor", () => {
    const missing = window({ kind: "google:gemini-weekly", utilization: 60, resetsAt: 1_000, missingSince: 500 });
    const live = window({ kind: "google:3p-weekly", utilization: 20, resetsAt: 9_000 });
    expect(currentWindows(usage(missing, live), 2_000_000)).toEqual([live]);
    expect(currentWindows(usage(missing, live), 900_000)).toEqual([missing, live]);
});

// The one rule the daemon's verdict and the editor's live re-reading both judge a standing refusal by (2026-10-20: the
// editor drew "spent until 19:55", the pinned pool's own reset, over a daemon verdict of 15:53).
test("a standing refusal pins the pool its model spends, reopening when the provider said, for every surface alike", () => {
    const reading = at(2_000, window({ kind: "five_hour", utilization: 0, resetsAt: 20_000 }), window({ kind: "seven_day", utilization: 0, resetsAt: 600_000 }));
    const said = refusal({ kind: "limit", model: "gpt-6.1-sol", resetsAt: 9_000 });
    expect(judgedReading(reading, [said])?.windows.map((entry) => [entry.kind, entry.utilization, entry.resetsAt])).toEqual([
        ["five_hour", 100, 9_000],
        ["seven_day", 0, 600_000],
    ]);
    expect(serviceState({ account: "a", usage: reading }, [said], undefined, 0)).toEqual({ kind: "spent", reopensAt: 9_000 });
    // Where it named no instant, the pinned pool keeps its own reset, and that is when it reopens.
    expect(serviceState({ account: "a", usage: reading }, [{ ...said, resetsAt: undefined }], undefined, 0)).toEqual({ kind: "spent", reopensAt: 20_000 });
    // No reading at all (a plan that publishes none): the refusal is a pool of its own, for its own model and no other's.
    expect(judgedReading(undefined, [said])?.windows).toEqual([
        { kind: "refused:gpt-6.1-sol", label: "GPT 6.1 Sol", utilization: 100, gates: { models: ["gpt-6.1-sol"] }, resetsAt: 9_000 },
    ]);
    expect(serviceState({ account: "a" }, [said], undefined, 0)).toEqual({ kind: "spent", reopensAt: 9_000, pool: "GPT 6.1 Sol" });
    expect(serviceState({ account: "a" }, [said], { id: "gpt-6-luna" }, 0)).toEqual({ kind: "unknown" });
});

// 2026-10-09/10-20: a routed model's bench (model-cooldowns.json) and the provider's last refusal were two copies of one
// refusal, and the picker greyed by one while the rail judged by the other. One ledger: every refusal standing over an
// account is laid on its reading, so two models refused on two pools both read spent.
test("every refusal standing over an account is laid on it, not only the provider's last", () => {
    const reading = at(
        500,
        window({ kind: "five_hour", utilization: 10, resetsAt: 7_000 }),
        window({ kind: "model:Opus", label: "Opus", utilization: 40, resetsAt: 8_000, gates: { models: ["opus"] } }),
    );
    const opus = refusal({ kind: "limit", account: "a", model: "claude-opus-5-5", at: 1_000 });
    const sonnet = refusal({ kind: "limit", account: "a", model: "claude-sonnet-5", at: 2_000, resetsAt: 7_000 });
    const states = (model: string) => serviceStates([{ account: "a", usage: reading }], [opus, sonnet], { id: model }, 5_000).get("a");
    expect(states("claude-opus-5-5")).toEqual({ kind: "spent", reopensAt: 8_000, pool: "Opus" });
    expect(states("claude-sonnet-5")).toEqual({ kind: "spent", reopensAt: 7_000 });
    // A spent allowance refused after a refused sign-in says the sign-in worked: the newest word on the account decides.
    const revoked = refusal({ kind: "auth", account: "a", at: 1_500 });
    expect(serviceStates([{ account: "a", usage: reading }], [revoked, sonnet], { id: "claude-sonnet-5" }, 5_000).get("a")).toEqual({ kind: "spent", reopensAt: 7_000 });
});

// 2026-10-17: a Kimi credential benched for thirty minutes, its five-hour window two hours from reopening, was re-run at
// thirty minutes and refused again. A bench is a floor under the account's reopening, never the reopening itself.
test("a translator bench lifts only once the pools it holds have reopened too", () => {
    const full = at(500, window({ kind: "five_hour", utilization: 100, resetsAt: 9_000 }));
    expect(serviceState({ account: "a", usage: full, cooling: { until: 2_000, reason: "429" } }, [], undefined, 1_000_000)).toEqual({
        kind: "blocked",
        fix: "wait",
        reason: "429",
        until: 9_000,
    });
});

// The answer every gate, listing and picker reads (2026-10-13: Sol subagents spawned onto a Codex whose every account
// was refused, while the picker greyed the row; 2026-10-19: Auto read the readings alone).
test("a provider's capacity for a model is spent only when no account can serve it, and says when one is back", () => {
    const room = at(5_000, window({ kind: "five_hour", utilization: 30, resetsAt: 9_000 }));
    const accounts = [
        { account: "a", usage: room },
        { account: "b", usage: room },
    ];
    const a = refusal({ kind: "limit", account: "a", model: "sol", resetsAt: 8_000, at: 4_000 });
    const b = refusal({ kind: "limit", account: "b", model: "sol", resetsAt: 7_000, at: 4_000 });
    expect(fleetCapacity(accounts, [a, b], { id: "sol" }, 6_000_000)).toEqual({ kind: "spent", accounts: 2, reopensAt: 7_000, pool: undefined });
    expect(fleetCapacity(accounts, [a], { id: "sol" }, 6_000_000)).toEqual({ kind: "serving", serving: 1, accounts: 2, roomMeasuredAt: 5_000 });
    // An account nothing has measured may still answer: it keeps the model servable.
    expect(fleetCapacity([...accounts, { account: "c" }], [a, b], { id: "sol" }, 6_000_000)).toEqual({ kind: "serving", serving: 1, accounts: 3, roomMeasuredAt: undefined });
    // No account at all says nothing either way.
    expect(fleetCapacity([], [a], { id: "sol" })).toEqual({ kind: "unknown" });
    // A plan that publishes no reading (Cursor's) is spent for a model every account refused, and only that model.
    const cursor = [{ account: "x" }, { account: "y" }];
    const refused = [refusal({ kind: "limit", account: "x", model: "composer-2.5" }), refusal({ kind: "limit", account: "y", model: "composer-2.5" })];
    expect(fleetCapacity(cursor, refused, { id: "composer-2.5" }, 2_000).kind).toBe("spent");
    expect(fleetCapacity(cursor, refused, { id: "gpt-6" }, 2_000).kind).toBe("serving");
    // An account refused outright is blocked for every model.
    expect(fleetCapacity([{ account: "x" }], [refusal({ kind: "entitlement", account: "x" })], { id: "gpt-6" }, 2_000).kind).toBe("spent");
});

test("an answer on one model covers another only where every pool the other spends gates it too", () => {
    const codex = usage(window({ kind: "five_hour", utilization: 0 }), window({ kind: "seven_day", utilization: 0 }));
    expect(answerCovers(codex, { id: "gpt-6-luna" }, { id: "gpt-6.1-sol" })).toBe(true);
    // A plan with no entitlement to a model meters it by a pool of its own.
    const free = usage(window({ kind: "monthly", utilization: 0 }), window({ kind: "entitlement:gpt-6.1-sol", utilization: 100, gates: { models: ["gpt-6.1-sol"] } }));
    expect(answerCovers(free, { id: "gpt-6-luna" }, { id: "gpt-6.1-sol" })).toBe(false);
    // Haiku's answer says nothing of Opus's own slice, and Opus's says everything of Haiku's pools.
    expect(answerCovers(CLAUDE, { id: "claude-haiku-4-5" }, { id: "claude-opus-4-6" })).toBe(false);
    expect(answerCovers(CLAUDE, { id: "claude-opus-4-6" }, { id: "claude-haiku-4-5" })).toBe(true);
    // Nothing read proves nothing.
    expect(answerCovers(undefined, { id: "gpt-6-luna" }, { id: "gpt-6.1-sol" })).toBe(false);
});
