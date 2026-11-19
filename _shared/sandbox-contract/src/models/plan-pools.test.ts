import {
    answerCovers,
    bindingWindow,
    currentWindows,
    FLAPPING_WINDOW_MS,
    flappingAccounts,
    gatesModel,
    gatingWindows,
    judgedReading,
    fleetCapacity,
    readingHeadroom,
    preferredAccount,
    refusalVerdict,
    refusedInstant,
    refusedPoolOf,
    refusedPoolReset,
    stampedRefusal,
    bestWithRoom,
    capacityValidUntil,
    NEARLY_OUT_ROOM,
    renewalOf,
    scopedWindow,
    uncoveredModels,
    serviceState,
    serviceStates,
    windowLive,
    windowPeriod,
} from "./plan-pools.js";
import type { AccountState, AccountUsage, ProviderRefusal, UsageWindow } from "../schemas/providers/plan-limits.js";
import type { ServiceFacts } from "./plan-pools.js";

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

// 2026-11-19: the reader states the length where the provider's answer says it (UsageWindow.periodSeconds), once, and
// every judgement reads that rather than the words. A window filed before then keeps being read off its words.
test("a window's stated length outranks its key and its name, and is named as the words would name it", () => {
    // A key that says one length and a statement that says another: the statement is the provider's word.
    expect(windowPeriod({ kind: "five_hour", periodSeconds: 86_400 })).toEqual({ seconds: 86_400, short: "24h" });
    // Claude's model slice, named only by its model, has a length once its reader states the week its key named.
    expect(windowPeriod({ kind: "model:Fable", label: "Fable", periodSeconds: 604_800 })).toEqual({ seconds: 604_800, short: "wk" });
    expect(windowPeriod({ kind: "model:Fable", label: "Fable" })).toBeUndefined();
    const stated = (periodSeconds: number) => windowPeriod({ kind: "claude:tangelo", periodSeconds })?.short;
    expect(stated(18_000)).toBe("5h");
    expect(stated(43_200)).toBe("12h");
    expect(stated(86_400)).toBe("24h");
    expect(stated(3 * 86_400)).toBe("3d");
    expect(stated(604_800)).toBe("wk");
    expect(stated(28 * 86_400)).toBe("mo");
    expect(stated(30 * 86_400)).toBe("mo");
    expect(stated(31 * 86_400)).toBe("mo");
    expect(stated(32 * 86_400)).toBe("32d");
    expect(stated(1_800)).toBe("30m");
    expect(stated(90)).toBe("90s");

    // It is what a reading with no published reset is trusted for, and what the renewal a pick weighs is judged by.
    const NOW = 1_700_000_000_000;
    const DAY = 86_400_000;
    const slice = window({ kind: "model:Fable", label: "Fable", utilization: 40, periodSeconds: 604_800 });
    expect(windowLive(slice, NOW - 6 * DAY, NOW)).toBe(true);
    expect(windowLive(slice, NOW - 8 * DAY, NOW)).toBe(false);
    const fiveHour = window({ kind: "five_hour", resetsAt: 100 });
    expect(renewalOf([fiveHour, window({ kind: "model:Fable", label: "Fable", resetsAt: 900, periodSeconds: 604_800 })])).toBe(900);
    expect(renewalOf([fiveHour, window({ kind: "model:Fable", label: "Fable", resetsAt: 900 })])).toBe(100);
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
// An instant inside every window the fixtures below read in the first seconds of the epoch (a five-hour pool measured at
// 500 ms is current until 18,000,500 ms): the rule takes each reading as it stands at the instant it judges, so a fixture
// judged by today's clock would read every such window long closed.
const SOON = 10_000;

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
    expect(readingHeadroom(atLine)).toEqual({ kind: "ready", room: 0, renewsAt: 900 });
    expect(readingHeadroom(atLine, { id: "claude-opus-5-5" })).toEqual({ kind: "ready", room: 0, renewsAt: 900 });
    // A precise 100 is still spent.
    expect(readingHeadroom(usage(window({ kind: "seven_day", utilization: 100, resetsAt: 900 })))).toEqual({ kind: "spent", reopensAt: 900 });
    // The provider refused it: spent until the pool reopens, and a reading still at the line does not answer that.
    const facts = { account: "a", usage: { ...atLine, measuredAt: 2_000 } };
    const refused = refusal({ kind: "limit", account: "a" });
    expect(refusalVerdict(refused, [facts], SOON)).toBe("standing");
    expect(serviceStates([facts], [refused], undefined, SOON).get("a")).toEqual({ kind: "spent", reopensAt: 900 });
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
    expect(serviceState({ ...facts, needsReauth: true, seatRefusal: "no seat" }, [], undefined, Date.now())).toEqual({ kind: "blocked", fix: "reconnect", reason: "sign-in expired" });
    expect(serviceState({ ...facts, seatRefusal: "Your org disabled Claude Code." }, [], undefined, Date.now())).toEqual({
        kind: "blocked",
        fix: "admin",
        reason: "Your org disabled Claude Code.",
    });
    expect(serviceState({ ...facts, cooling: { reason: "no project" } }, [], undefined, Date.now())).toEqual({ kind: "blocked", fix: "reconnect", reason: "no project" });
    expect(serviceState({ ...facts, cooling: { until: 2_000 } }, [], undefined, 1_000_000)).toEqual({
        kind: "blocked",
        fix: "wait",
        reason: "cooling down",
        until: 2_000,
    });
    // One Google wants its owner to verify: neither waiting nor reconnecting lifts it, and the row carries the page.
    expect(serviceState({ ...facts, cooling: { reason: "Verify your account to continue.", verify: "https://accounts.google.com/v" } }, [], undefined, Date.now())).toEqual({
        kind: "blocked",
        fix: "verify",
        reason: "Verify your account to continue.",
        url: "https://accounts.google.com/v",
    });
    // A bench whose instant has passed is over.
    expect(serviceState({ ...facts, cooling: { until: 999 } }, [], undefined, 1_000_000)).toEqual({ kind: "ready", room: 100 });
});

test("a standing refusal blocks by its kind, and a limit refusal pins only the pool its model spends", () => {
    const facts = { account: "a", usage: CLAUDE };
    expect(serviceState(facts, [refusal({ kind: "auth" })], undefined, SOON)).toEqual({ kind: "blocked", fix: "reconnect", reason: "no." });
    expect(serviceState(facts, [refusal({ kind: "entitlement" })], undefined, SOON)).toEqual({ kind: "blocked", fix: "admin", reason: "no." });
    // Refused on Haiku: the 5-hour/weekly binding pool (seven_day, 30%) reads full, so Haiku is spent too.
    expect(serviceState(facts, [refusal({ kind: "limit", model: "claude-haiku-4-5" })], { id: "claude-haiku-4-5" }, SOON)).toEqual({ kind: "spent" });
    // Refused on Opus: its own slice was already full; Haiku keeps the room its pools show.
    expect(serviceState(facts, [refusal({ kind: "limit", model: "claude-opus-4-6" })], { id: "claude-haiku-4-5" }, SOON)).toEqual({ kind: "ready", room: 70 });
    // No reading at all: the refusal is the evidence, unless it was about another model.
    expect(serviceState({ account: "a" }, [refusal({ kind: "limit" })], undefined, SOON)).toEqual({ kind: "spent" });
    expect(serviceState({ account: "a" }, [refusal({ kind: "limit", model: "opus" })], { id: "haiku" }, SOON)).toEqual({ kind: "unknown" });
});

test("a refusal stands until a later reading contradicts it, and never past its account's disconnection", () => {
    const room = at(2_000, window({ kind: "five_hour", utilization: 40 }));
    const full = at(2_000, window({ kind: "five_hour", utilization: 100 }));
    const before = at(500, window({ kind: "five_hour", utilization: 40 }));
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [{ account: "a", usage: room }], SOON)).toBe("answered");
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [{ account: "a", usage: full }], SOON)).toBe("standing");
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [{ account: "a", usage: before }], SOON)).toBe("standing");
    // Another account's room proves nothing about the one refused.
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [{ account: "a", usage: before }, { account: "b", usage: room }], SOON)).toBe("standing");
    // A refusal naming no account is answered on each account by that account's own reading: b's room frees b, not a.
    const nameless = refusal({ kind: "limit" });
    expect(refusalVerdict(nameless, [{ account: "a", usage: before }, { account: "b", usage: room }], SOON)).toBe("standing");
    expect(Object.fromEntries(serviceStates([{ account: "a", usage: before }, { account: "b", usage: room }], [nameless], undefined, SOON))).toEqual({
        a: { kind: "spent" },
        b: { kind: "ready", room: 60 },
    });
    expect(refusalVerdict(nameless, [{ account: "a", usage: room }, { account: "b", usage: room }], SOON)).toBe("answered");
    expect(refusalVerdict(refusal({ kind: "auth", account: "a" }), [{ account: "a", usage: full }], SOON)).toBe("answered");
    expect(refusalVerdict(refusal({ kind: "auth", account: "a" }), [{ account: "a", usage: full, needsReauth: true }], SOON)).toBe("standing");
    expect(refusalVerdict(refusal({ kind: "entitlement", account: "a" }), [{ account: "a", usage: room }], SOON)).toBe("standing");
    expect(refusalVerdict(refusal({ kind: "limit", account: "gone" }), [{ account: "a", usage: room }], SOON)).toBe("gone");
    expect(refusalVerdict(refusal({ kind: "limit", account: "a" }), [], SOON)).toBe("standing");
});

// An admin's allowance (Cursor's team spend limit) is one the refused account's own reading does not measure.
test("an allowance no reading measures stands against its own account's reading, until the provider's own reset", () => {
    const room = at(Date.now() + 60_000, window({ kind: "seven_day", utilization: 43 }));
    const credit = refusal({ kind: "limit", unmetered: true, at: Date.now(), resetsAt: Math.floor(Date.now() / 1000) + 3_600 });
    expect(refusalVerdict({ ...credit, account: "a" }, [{ account: "a", usage: room }, { account: "b", usage: room }], Date.now())).toBe("standing");
    expect(refusalVerdict(credit, [{ account: "a", usage: room }], Date.now())).toBe("standing");
    expect(refusalVerdict({ ...credit, account: "a", resetsAt: Math.floor(Date.now() / 1000) - 1 }, [{ account: "a", usage: room }], Date.now())).toBe("answered");
    expect(refusalVerdict({ ...credit, resetsAt: undefined }, [{ account: "a", usage: room }], Date.now())).toBe("standing");
});

// 2026-10-19: one routed refusal ("try again at 1:53 PM", filed a day out, as an admin's credit) named no account and
// held all three Codex accounts spent for that day, two free ones reading 0% of their month used among them.
test("a nameless refusal over several accounts is answered on each by its own reading of room since, whatever it named", () => {
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
    // Until each is read with room after it, it stands over that one: the team account read first frees only itself.
    const before = accounts.map((entry) => ({ ...entry, usage: { ...entry.usage, measuredAt: filed - 1 } }));
    expect(refusalVerdict(codex, before, now)).toBe("standing");
    const teamRead = before.map((entry) => (entry.account === "team" ? accounts[2]! : entry));
    expect(Object.fromEntries(serviceStates(teamRead, [codex], undefined, now))).toEqual({
        "free-1": { kind: "spent", reopensAt: Date.parse("2026-10-20T13:53:00Z") / 1000 },
        "free-2": { kind: "spent", reopensAt: Date.parse("2026-10-20T13:53:00Z") / 1000 },
        team: { kind: "ready", room: 100 },
    });
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
    // Over several, nothing says which one refused, so on each it is that account's own reading of room since that answers it.
    expect(refusalVerdict(refusal(until), [{ account: "a", usage: room }, { account: "b", usage: room }], 9_999)).toBe("answered");
    const stale = at(500, window({ kind: "five_hour", utilization: 0 }));
    expect(refusalVerdict(refusal(until), [{ account: "a", usage: room }, { account: "b", usage: stale }], 9_999)).toBe("standing");
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
    expect(serviceStates([{ account: "a", usage: lapsed }], [filed], undefined, reset * 1000).get("a")).toEqual({ kind: "ready", room: 60, renewsAt: 900 });
});

// 2026-10-21: Claude refused at 5h 98% and weekly 97% (rounded) with no time named, so the refusal was stamped with the
// five-hour reset, the fullest pool then. Once that window reopened the weekly pool read 100, and the passed stamp ended
// the refusal anyway: a rounded 100 is no proof of empty, so the account read ready with no room and every turn let
// through was refused again. A stamp ends the refusal where nothing read since says otherwise, never over a reading.
test("a stamped reset ends a refusal only where no reading since it says the pool is still at the line", () => {
    const fiveHourReset = 1_800_000_000;
    const weeklyReset = 1_800_259_200;
    const refusedIn = at(
        1_799_989_000_000,
        window({ kind: "five_hour", utilization: 98, rounded: true, resetsAt: fiveHourReset }),
        window({ kind: "seven_day", utilization: 97, rounded: true, resetsAt: weeklyReset }),
    );
    const spent = refusal({ kind: "limit", account: "a", at: 1_799_990_000_000 });
    expect(refusedPoolReset(spent, [{ account: "a", usage: refusedIn }])).toBe(fiveHourReset);
    const stamped = { ...spent, poolResetsAt: fiveHourReset };
    const now = (fiveHourReset + 700) * 1000;
    const weeklyFull = at(
        (fiveHourReset + 600) * 1000,
        window({ kind: "five_hour", utilization: 4, rounded: true, resetsAt: fiveHourReset + 18_000 }),
        window({ kind: "seven_day", utilization: 100, rounded: true, resetsAt: weeklyReset }),
    );
    const unstampedVerdict = serviceStates([{ account: "a", usage: weeklyFull }], [spent], undefined, now).get("a");
    expect(unstampedVerdict).toEqual({ kind: "spent", reopensAt: weeklyReset });
    expect(serviceStates([{ account: "a", usage: weeklyFull }], [stamped], undefined, now).get("a")).toEqual(unstampedVerdict);
    expect(fleetCapacity([{ account: "a", usage: weeklyFull }], [stamped], undefined, now)).toMatchObject({ kind: "spent", reopensAt: weeklyReset });
    // Nothing read since the stamp: it ends there. Read with room since: over. The five-hour pool the refusal came in
    // reset 700 s before `now`, so it reads lapsed at the floor and the weekly pool at 97 binds.
    expect(serviceStates([{ account: "a", usage: refusedIn }], [stamped], undefined, now).get("a")).toEqual({ kind: "ready", room: 3, renewsAt: weeklyReset });
    const roomSince = at((fiveHourReset + 600) * 1000, window({ kind: "five_hour", utilization: 4, resetsAt: fiveHourReset + 18_000 }), window({ kind: "seven_day", utilization: 60, resetsAt: weeklyReset }));
    expect(refusalVerdict(stamped, [{ account: "a", usage: roomSince }], now)).toBe("answered");
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
    const states = serviceStates([{ account: "a", usage: room }, { account: "b", usage: room }], [refusal({ kind: "entitlement", account: "a" })], undefined, SOON);
    expect(Object.fromEntries(states)).toEqual({ a: { kind: "blocked", fix: "admin", reason: "no." }, b: { kind: "ready", room: 60 } });
    const answered = serviceStates([{ account: "a", usage: at(2_000, window({ kind: "five_hour", utilization: 40 })) }], [refusal({ kind: "limit", account: "a" })], undefined, SOON);
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
    expect(serviceStates(accounts, [elsewhere], undefined, 9_999).get("a")).toEqual({ kind: "ready", room: 0, renewsAt: 20 });
    // Past the instant the provider named, its refusal is over, and so is the window the reading at the line was taken
    // in, which reset at that same instant: nothing measures the account until it is read again.
    expect(serviceStates(accounts, [elsewhere, own], undefined, 20_000).get("a")).toEqual({ kind: "unknown" });
    // A newer refusal on the same account outranks the older one.
    const revoked = refusal({ kind: "auth", account: "a", at: 6_000 });
    expect(serviceStates(accounts, [own, revoked], undefined, 9_999).get("a")).toEqual({ kind: "blocked", fix: "reconnect", reason: "no." });
});

test("a reading answers a spent allowance only in the pool the refused model spends", () => {
    const pools = (claude: number, gemini: number): AccountUsage =>
        at(
            2_000,
            window({ kind: "google:3p-weekly", label: "Claude and GPT models", utilization: claude, gates: { models: ["claude", "gpt"] } }),
            window({ kind: "google:models:gemini", label: "Gemini models", utilization: gemini, gates: { models: ["gemini"] } }),
        );
    const flash = refusal({ kind: "limit", account: "a", model: "gemini-3.8-flash-high" });
    // Claude spent, Gemini open: room where Flash spends answers it, the full Claude pool notwithstanding.
    expect(refusalVerdict(flash, [{ account: "a", usage: pools(100, 40) }], Date.now())).toBe("answered");
    // Claude open, Gemini full: room in a pool Flash never spends answers nothing.
    expect(refusalVerdict(flash, [{ account: "a", usage: pools(0, 100) }], Date.now())).toBe("standing");
});

// 2026-11-08 (ci-fix-intentic-42395805126-attempt2): the translator tried five of 31 Google accounts per send, all
// spent, and never the one with room. Each refusal, filed under no account, pinned every account full until the re-read
// it forced landed seconds later, and that one account's reading then answered it for all 31: Opus and Flash each read
// 0% and then 100% again while every turn on them was refused, and both were never spent at once.
test("refusals naming their accounts hold a 31-account Google fleet steady across the re-read they force", () => {
    const refusedAt = Date.parse("2026-11-08T11:11:45Z");
    const reread = refusedAt + 5_000;
    const opusBack = Date.parse("2026-11-14T12:04:18Z") / 1000;
    const flashBack = Date.parse("2026-11-14T20:05:20Z") / 1000;
    const pools = (measuredAt: number, claude: number, gemini: number): AccountUsage =>
        at(
            measuredAt,
            window({ kind: "google:3p-weekly", label: "Claude and GPT models", utilization: claude, resetsAt: opusBack, gates: { models: ["claude", "gpt"] } }),
            window({ kind: "google:models:gemini", label: "Gemini models", utilization: gemini, resetsAt: flashBack, gates: { models: ["gemini"] } }),
        );
    const tried = Array.from({ length: 10 }, (_, index) => `tried-${index}`);
    const untried = Array.from({ length: 19 }, (_, index) => `untried-${index}`);
    const fleet = (measuredAt: number): ServiceFacts[] => [
        ...[...tried, ...untried].map((account) => ({ account, usage: pools(measuredAt, 100, 100) })),
        { account: "radarsuspam6", usage: pools(measuredAt, 100, 99.61) },
        { account: "svichita09", usage: pools(measuredAt, 0, 19.42) },
    ];
    const refused = tried.flatMap((account) => [
        refusal({ kind: "limit", account, at: refusedAt, model: "claude-opus-4-6-thinking", resetsAt: opusBack }),
        refusal({ kind: "limit", account, at: refusedAt, model: "gemini-3.8-flash-high", resetsAt: flashBack }),
    ]);
    const opus = { id: "claude-opus-4-6-thinking" };
    const flash = { id: "gemini-3.8-flash-high" };
    for (const accounts of [fleet(refusedAt - 30_000), fleet(reread)]) {
        expect(fleetCapacity(accounts, refused, opus, reread)).toMatchObject({ kind: "serving", serving: 1, accounts: 31 });
        expect(fleetCapacity(accounts, refused, flash, reread)).toMatchObject({ kind: "serving", serving: 2, accounts: 31 });
        const states = serviceStates(accounts, refused, opus, reread);
        expect(states.get("tried-0")).toEqual({ kind: "spent", reopensAt: opusBack, pool: "Claude and GPT models" });
        expect(states.get("svichita09")).toEqual({ kind: "ready", room: 100, renewsAt: opusBack });
    }
    // The same refusal filed under no account is answered on each account by its own reading alone: the account with
    // room frees itself, never one whose reading since says nothing.
    const nameless = refusal({ kind: "limit", at: refusedAt, model: "claude-opus-4-6-thinking", resetsAt: opusBack });
    const onlyOneRead = fleet(refusedAt - 30_000).map((facts) => (facts.account === "svichita09" ? { ...facts, usage: pools(reread, 0, 19.42) } : facts));
    const states = serviceStates([...onlyOneRead, { account: "unread" }], [nameless], opus, reread);
    expect(states.get("svichita09")).toEqual({ kind: "ready", room: 100, renewsAt: opusBack });
    expect(states.get("unread")).toMatchObject({ kind: "spent", reopensAt: opusBack });
});

// The translator's per-model benches are the provider's refusals of each account it tried, with the provider's instant:
// read as such, the same fleet holds without a refusal on file, and a bench on one model leaves the account's others.
test("a translator's per-model bench holds its account spent on that model alone, until the provider's instant", () => {
    const opusBack = Date.parse("2026-11-14T12:03:41Z") / 1000;
    const now = Date.parse("2026-11-08T11:12:00Z");
    const room = at(now - 1_000, window({ kind: "google:3p-weekly", label: "Claude and GPT models", utilization: 0, gates: { models: ["claude", "gpt"] } }), window({ kind: "google:models:gemini", label: "Gemini models", utilization: 20, gates: { models: ["gemini"] } }));
    const benched: ServiceFacts = { account: "a", usage: room, cooldowns: [{ model: "claude-opus-4-6-thinking", until: opusBack }] };
    const accounts = [benched, { account: "b", usage: room }];
    // A reading with room taken after the bench answers nothing: the provider named when.
    expect(serviceStates(accounts, [], { id: "claude-opus-4-6-thinking" }, now).get("a")).toEqual({ kind: "spent", reopensAt: opusBack, pool: "Claude and GPT models" });
    expect(serviceStates(accounts, [], { id: "gemini-3.8-flash-high" }, now).get("a")).toEqual({ kind: "ready", room: 80 });
    expect(fleetCapacity(accounts, [], { id: "claude-opus-4-6-thinking" }, now)).toMatchObject({ kind: "serving", serving: 1, accounts: 2 });
    // Past the instant it is over, and the reading speaks alone.
    expect(serviceStates(accounts, [], { id: "claude-opus-4-6-thinking" }, opusBack * 1000).get("a")).toEqual({ kind: "ready", room: 100 });
    // A revoked sign-in filed since is the account's newer word.
    expect(serviceStates(accounts, [refusal({ kind: "auth", account: "a", at: now })], { id: "claude-opus-4-6-thinking" }, now).get("a")).toMatchObject({ kind: "blocked", fix: "reconnect" });
});

test("an unnamed turn takes the most room, then an unmeasured account, then a spent one, and a blocked one only when that is all", () => {
    const entry = (id: string, state: AccountState) => ({ id, state });
    const blocked: AccountState = { kind: "blocked", fix: "admin", reason: "no seat" };
    expect(preferredAccount([entry("seatless", blocked), entry("spent", { kind: "spent" }), entry("low", { kind: "ready", room: 5 }), entry("high", { kind: "ready", room: 60 })])?.id).toBe("high");
    expect(preferredAccount([entry("seatless", blocked), entry("spent", { kind: "spent" }), entry("unread", { kind: "unknown" })])?.id).toBe("unread");
    expect(preferredAccount([entry("seatless", blocked), entry("spent", { kind: "spent" })])?.id).toBe("spent");
    expect(preferredAccount([entry("seatless", blocked), entry("other", blocked)])?.id).toBe("seatless");
    expect(preferredAccount([entry("first", { kind: "ready", room: 60 }), entry("second", { kind: "ready", room: 60 })])?.id).toBe("first");
    expect(bestWithRoom([entry("seatless", blocked), entry("unread", { kind: "unknown" })])).toBeUndefined();
    expect(bestWithRoom([entry("low", { kind: "ready", room: 5 }), entry("high", { kind: "ready", room: 60 })])?.id).toBe("high");
});

/* 2026-11-17: Claude's Ultra plan meters no five-hour window. One account had 70 weekly points left renewing in six days,
   the other 40 renewing in ten hours, and the most-room pick spent the first while the second's reset unspent. */
test("between accounts with room, the one whose allowance renews first wins, unless it is nearly out", () => {
    const entry = (id: string, state: AccountState) => ({ id, state });
    const now = 1_800_000_000;
    const later = entry("later", { kind: "ready", room: 70, renewsAt: now + 144 * 3_600 });
    const sooner = entry("sooner", { kind: "ready", room: 40, renewsAt: now + 10 * 3_600 });
    expect(preferredAccount([later, sooner])?.id).toBe("sooner");
    expect(bestWithRoom([later, sooner])?.id).toBe("sooner");
    // Nearly out, it ranks after every account with more, however soon it renews; among those, room decides.
    const nearlyOut = entry("nearly-out", { kind: "ready", room: NEARLY_OUT_ROOM, renewsAt: now + 3_600 });
    expect(preferredAccount([nearlyOut, later])?.id).toBe("later");
    expect(preferredAccount([nearlyOut, entry("lower", { kind: "ready", room: 4, renewsAt: now })])?.id).toBe("nearly-out");
    // A reset nobody published never outranks a known one; between two unknown, room decides as before.
    expect(preferredAccount([entry("unknown", { kind: "ready", room: 90 }), sooner])?.id).toBe("sooner");
    expect(preferredAccount([entry("a", { kind: "ready", room: 50 }), entry("b", { kind: "ready", room: 60 })])?.id).toBe("b");
    // The same moment: room decides.
    expect(preferredAccount([sooner, entry("roomier", { kind: "ready", room: 80, renewsAt: now + 10 * 3_600 })])?.id).toBe("roomier");
});

test("an allowance renews when the longest pool the turn spends resets, never when a five-hour one does", () => {
    const now = 1_800_000_000;
    const weekly = (utilization: number, resetsAt: number): UsageWindow => ({ kind: "seven_day", utilization, resetsAt, gates: "all" });
    const fiveHour: UsageWindow = { kind: "five_hour", utilization: 90, resetsAt: now + 3_600, gates: "all" };
    expect(renewalOf([fiveHour, weekly(40, now + 20 * 3_600)])).toBe(now + 20 * 3_600);
    // Two weekly pools (the whole plan's and Opus's slice): the first of them to reset.
    expect(renewalOf([weekly(40, now + 50 * 3_600), { ...weekly(10, now + 30 * 3_600), kind: "seven_day_opus", gates: { models: ["opus"] } }])).toBe(now + 30 * 3_600);
    // The weekly pool has lapsed (its reset passed, nothing re-read it): what renews is unknown, not the five-hour reset.
    expect(renewalOf([fiveHour, { kind: "seven_day", utilization: 0, gates: "all", lapsedAt: now }])).toBeUndefined();
    // No pool names its length: the first to reset decides.
    expect(renewalOf([{ kind: "pool:a", utilization: 10, resetsAt: now + 7_200, gates: "all" }, { kind: "pool:b", utilization: 10, resetsAt: now + 3_600, gates: "all" }])).toBe(now + 3_600);
    // The verdict carries it, read off the pools still open.
    expect(readingHeadroom({ windows: [fiveHour, weekly(40, now + 20 * 3_600)], measuredAt: now * 1000 })).toEqual({ kind: "ready", room: 10, renewsAt: now + 20 * 3_600 });
});

test("an account at the line is tried after an unmeasured one and before a spent one, and never a move's destination", () => {
    const entry = (id: string, state: AccountState) => ({ id, state });
    const atLine: AccountState = { kind: "ready", room: 0 };
    expect(preferredAccount([entry("line", atLine), entry("low", { kind: "ready", room: 2 })])?.id).toBe("low");
    expect(preferredAccount([entry("line", atLine), entry("unread", { kind: "unknown" })])?.id).toBe("unread");
    expect(preferredAccount([entry("spent", { kind: "spent" }), entry("line", atLine)])?.id).toBe("line");
    // A move lands only on proven room: two accounts at the line would otherwise hand a refused turn back and forth.
    expect(bestWithRoom([entry("line", atLine), entry("spent", { kind: "spent" })])).toBeUndefined();
    expect(bestWithRoom([entry("line", atLine), entry("low", { kind: "ready", room: 2 })])?.id).toBe("low");
});

// The 2026-10-27/28 account: switched off, served for an evening (most room on its reading), switched off again.
test("an account its organisation keeps switching off goes behind every steady one of its tier, never behind a worse tier", () => {
    const entry = (id: string, state: AccountState, flapping?: boolean) => ({ id, state, flapping });
    const flapping = entry("flapping", { kind: "ready", room: 90 }, true);
    expect(preferredAccount([flapping, entry("steady", { kind: "ready", room: 5 })])?.id).toBe("steady");
    expect(bestWithRoom([flapping, entry("steady", { kind: "ready", room: 5 }, false)])?.id).toBe("steady");
    expect(preferredAccount([flapping, entry("unread", { kind: "unknown" }), entry("line", { kind: "ready", room: 0 })])?.id).toBe("flapping");
    expect(bestWithRoom([flapping, entry("line", { kind: "ready", room: 0 })])?.id).toBe("flapping");
    // Among flapping accounts, room decides again.
    expect(preferredAccount([flapping, entry("roomier", { kind: "ready", room: 95 }, true)])?.id).toBe("roomier");
    expect(preferredAccount([entry("off", { kind: "unknown" }, true), entry("on", { kind: "unknown" })])?.id).toBe("on");
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
    expect(readingHeadroom(contradicted, { id: "gemini-3.8-flash-high" })).toEqual({ kind: "ready", room: 0, renewsAt: 9_000 });
    expect(readingHeadroom(contradicted)).toEqual({ kind: "ready", room: 0, renewsAt: 9_000 });
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
    // Read before the refusal: nothing since says which pool its instant belongs to (refusedInstant).
    const reading = at(500, window({ kind: "five_hour", utilization: 0, resetsAt: 20_000 }), window({ kind: "seven_day", utilization: 0, resetsAt: 600_000 }));
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

// 2026-11-14: Codex refused GPT 6.1 Sol on 11-12 naming a reset of 11-18 14:21, which neither polled window had (five-hour
// 11-14, weekly 11-20, both mostly free). Pinned on the weekly window, which gates every model, it held every Codex model
// at the door for four days, and only a turn could have answered it.
test("a refusal's instant is judged against the pools a reading since publishes: theirs, a renewed one's, or a pool of its own", () => {
    const DAY = 86_400;
    const filed = Date.parse("2026-11-12T20:59:22Z");
    const instant = Date.parse("2026-11-18T14:21:08Z") / 1000;
    const now = Date.parse("2026-11-14T09:00:00Z");
    const sol = refusal({ kind: "limit", account: "a", model: "gpt-6.1-sol", resetsAt: instant, at: filed });
    const codex = (weekly: number, utilization = 30) =>
        at(now - 60_000, window({ kind: "five_hour", utilization: 36, resetsAt: now / 1000 + 3_600 }), window({ kind: "seven_day", utilization, resetsAt: weekly }));

    // The weekly window resets at the instant the provider named: the refusal is that window's, and stands until then.
    const same = codex(instant + 60);
    expect(refusedInstant(sol, same)).toBe("published");
    expect(refusalVerdict(sol, [{ account: "a", usage: same }], now)).toBe("standing");
    expect(serviceState({ account: "a", usage: same }, [sol], { id: "gpt-6-luna" }, now)).toEqual({ kind: "spent", reopensAt: instant });

    // The weekly window opened after the refusal was filed, with room: the allowance was renewed early, and it is over.
    const renewed = codex(Math.floor(now / 1000) + 6 * DAY);
    expect(refusedInstant(sol, renewed)).toBe("renewed");
    expect(refusalVerdict(sol, [{ account: "a", usage: renewed }], now)).toBe("answered");
    expect(serviceStates([{ account: "a", usage: renewed }], [sol], { id: "gpt-6.1-sol" }, now).get("a")).toEqual({ kind: "ready", room: 64, renewsAt: Math.floor(now / 1000) + 6 * DAY });
    // Renewed but already spent again: still held, by the window itself.
    expect(refusedInstant(sol, codex(Math.floor(now / 1000) + 6 * DAY, 100))).toBe("unpublished");

    // The weekly window opened before the refusal and resets elsewhere: the refusal is a pool the reading does not name.
    // It holds Sol alone, until its instant; Luna and every other model keep the room both windows show.
    const unnamed = codex(Math.floor(filed / 1000) + 5 * DAY);
    expect(refusedInstant(sol, unnamed)).toBe("unpublished");
    expect(refusalVerdict(sol, [{ account: "a", usage: unnamed }], now)).toBe("standing");
    expect(serviceState({ account: "a", usage: unnamed }, [sol], { id: "gpt-6.1-sol" }, now)).toEqual({ kind: "spent", reopensAt: instant, pool: "GPT 6.1 Sol" });
    expect(serviceState({ account: "a", usage: unnamed }, [sol], { id: "gpt-6-luna" }, now)).toEqual({ kind: "ready", room: 64, renewsAt: Math.floor(filed / 1000) + 5 * DAY });
    expect(serviceState({ account: "a", usage: unnamed }, [sol], undefined, now)).toEqual({ kind: "ready", room: 64, renewsAt: Math.floor(filed / 1000) + 5 * DAY });

    // Nothing read since the refusal, or a pool with no reset to judge by: the instant outranks, on the pool the model spends.
    expect(refusedInstant(sol, { ...unnamed, measuredAt: filed - 1 })).toBe("unjudged");
    expect(refusedInstant(sol, at(now, window({ kind: "five_hour", utilization: 36 }), window({ kind: "seven_day", utilization: 30 })))).toBe("unjudged");
    expect(serviceState({ account: "a", usage: { ...unnamed, measuredAt: filed - 1 } }, [sol], { id: "gpt-6-luna" }, now)).toMatchObject({ kind: "spent" });
});

// 2026-11-19: which pool a refusal's instant belongs to is resolved once, by the ledger as it files the refusal, from the
// reading beside it (refusedPoolOf), and every judgement after reads that stamp. Re-inferring it on each judgement from
// whatever reading it held was rejected: a reading taken once the pool had moved said something else.
describe("a spent allowance resolved to its pool as it was filed", () => {
    const DAY = 86_400;
    const filed = Date.parse("2026-11-12T20:59:22Z");
    const instant = Date.parse("2026-11-18T14:21:08Z") / 1000;
    const now = Date.parse("2026-11-14T09:00:00Z");
    const sol = refusal({ kind: "limit", account: "a", model: "gpt-6.1-sol", resetsAt: instant, at: filed });
    const codex = (measuredAt: number, weekly: number, utilization = 30) =>
        at(
            measuredAt,
            window({ kind: "five_hour", utilization: 36, resetsAt: Math.floor(measuredAt / 1000) + 3_600 }),
            window({ kind: "seven_day", utilization, resetsAt: weekly }),
        );
    // The reading beside the refusal as it is filed: taken a minute before it, as a polled one is.
    const filing = (weekly: number) => [{ account: "a", usage: codex(filed - 60_000, weekly) }];
    const since = (weekly: number, utilization = 30) => codex(now - 60_000, weekly, utilization);

    test("is the pool its instant was the reset of, from a reading taken before the refusal that no later judgement could read", () => {
        const accounts = filing(instant + 60);
        expect(refusedPoolOf(sol, accounts)).toEqual({ pool: "seven_day" });
        // The reading beside it predates the refusal, so judged afterwards it says nothing of the instant.
        expect(refusedInstant(sol, accounts[0]?.usage)).toBe("unjudged");
        expect(stampedRefusal(sol, accounts)).toEqual({ ...sol, pool: "seven_day" });
    });

    test("pins exactly that pool however far a reading since puts its reset from the instant, where an unstamped one is guessed again", () => {
        const stamped = { ...sol, pool: "seven_day" };
        // Read since with the weekly reset 40 minutes past the instant: outside the half hour that names one reset.
        const later = since(instant + 40 * 60);
        expect(refusedInstant(sol, later)).toBe("unpublished");
        expect(judgedReading(later, [stamped])?.windows.map((entry) => [entry.kind, entry.utilization, entry.resetsAt])).toEqual([
            ["five_hour", 36, Math.floor(now / 1000) - 60 + 3_600],
            ["seven_day", 100, instant],
        ]);
        expect(refusalVerdict(stamped, [{ account: "a", usage: later }], now)).toBe("standing");
        expect(serviceState({ account: "a", usage: later }, [stamped], { id: "gpt-6-luna" }, now)).toEqual({ kind: "spent", reopensAt: instant });
        // Unstamped, the same reading reads it as a pool of its own, holding Sol alone, as before.
        expect(serviceState({ account: "a", usage: later }, [sol], { id: "gpt-6-luna" }, now)).toEqual({ kind: "ready", room: 64, renewsAt: instant + 40 * 60 });
        expect(serviceState({ account: "a", usage: later }, [sol], { id: "gpt-6.1-sol" }, now)).toEqual({ kind: "spent", reopensAt: instant, pool: "GPT 6.1 Sol" });
    });

    test("is a pool of its own where its instant was no published pool's reset, whatever a reading since says", () => {
        const accounts = filing(Math.floor(filed / 1000) + 5 * DAY);
        expect(refusedPoolOf(sol, accounts)).toEqual({ poolUnpublished: true });
        const unpublished = { ...sol, poolUnpublished: true as const };
        // A reading since whose weekly reset happens to fall on the instant: unstamped, the refusal would be read as that
        // window's and hold every model; stamped, it holds Sol alone until its instant.
        const later = since(instant + 60);
        expect(refusedInstant(sol, later)).toBe("published");
        expect(serviceState({ account: "a", usage: later }, [sol], { id: "gpt-6-luna" }, now)).toEqual({ kind: "spent", reopensAt: instant });
        expect(serviceState({ account: "a", usage: later }, [unpublished], { id: "gpt-6-luna" }, now)).toEqual({ kind: "ready", room: 64, renewsAt: instant + 60 });
        expect(serviceState({ account: "a", usage: later }, [unpublished], { id: "gpt-6.1-sol" }, now)).toEqual({ kind: "spent", reopensAt: instant, pool: "GPT 6.1 Sol" });
        expect(refusalVerdict(unpublished, [{ account: "a", usage: later }], now)).toBe("standing");
    });

    test("is answered early once its pool has renewed since with room, and not while it is full again or no reading names it", () => {
        const stamped = { ...sol, pool: "seven_day" };
        const renewedAt = Math.floor(now / 1000) + 6 * DAY;
        expect(refusalVerdict(stamped, [{ account: "a", usage: since(renewedAt) }], now)).toBe("answered");
        expect(serviceStates([{ account: "a", usage: since(renewedAt) }], [stamped], { id: "gpt-6.1-sol" }, now).get("a")).toEqual({
            kind: "ready",
            room: 64,
            renewsAt: renewedAt,
        });
        expect(refusalVerdict(stamped, [{ account: "a", usage: since(renewedAt, 100) }], now)).toBe("standing");
        // A pool the reading no longer names cannot say it renewed: the provider's instant stands.
        expect(refusalVerdict({ ...sol, pool: "seven_day_retired" }, [{ account: "a", usage: since(renewedAt) }], now)).toBe("standing");
        // A pool of its own is answered as an unstamped one is: every window that could have held it renewed since.
        expect(refusalVerdict({ ...sol, poolUnpublished: true }, [{ account: "a", usage: since(renewedAt) }], now)).toBe("answered");
        expect(refusalVerdict({ ...sol, poolUnpublished: true }, [{ account: "a", usage: since(renewedAt, 100) }], now)).toBe("standing");
    });

    test("is the fullest of the pools resetting at its instant, so a model's own slice holds that model alone", () => {
        const weekly = 1_800_000_000;
        const claude = at(
            filed - 60_000,
            window({ kind: "five_hour", utilization: 20, resetsAt: Math.floor(filed / 1000) + 3_600 }),
            window({ kind: "seven_day", utilization: 60, resetsAt: weekly }),
            window({ kind: "model:Opus", label: "Opus", utilization: 100, resetsAt: weekly, periodSeconds: 7 * DAY, gates: { models: ["Opus"] } }),
        );
        const opus = refusal({ kind: "limit", account: "a", model: "claude-opus-5-5", resetsAt: weekly + 120, at: filed });
        expect(refusedPoolOf(opus, [{ account: "a", usage: claude }])).toEqual({ pool: "model:Opus" });
        const stamped = { ...opus, pool: "model:Opus" };
        expect(serviceState({ account: "a", usage: claude }, [stamped], { id: "claude-haiku-5" }, filed)).toEqual({ kind: "ready", room: 40, renewsAt: weekly });
        expect(serviceState({ account: "a", usage: claude }, [stamped], { id: "claude-opus-5-5" }, filed)).toEqual({ kind: "spent", reopensAt: weekly + 120, pool: "Opus" });
    });

    test("is left unresolved where the reading beside it cannot say, and judged as it stands then", () => {
        const accounts = filing(instant + 60);
        // A refusal naming no instant takes its pool's reset instead; one no reading measures, and a person's mark, nothing.
        const noInstant = refusal({ kind: "limit", account: "a", model: "gpt-6.1-sol", at: filed });
        expect(refusedPoolOf(noInstant, accounts)).toEqual({});
        expect(stampedRefusal(noInstant, accounts)).toEqual({ ...noInstant, poolResetsAt: Math.floor(filed / 1000) - 60 + 3_600 });
        expect(refusedPoolOf({ ...sol, unmetered: true }, accounts)).toEqual({});
        expect(refusedPoolOf({ ...sol, byHand: true }, accounts)).toEqual({});
        expect(refusedPoolOf({ ...sol, kind: "entitlement" }, accounts)).toEqual({});
        // Naming no account: resolved where the provider has only the one, never across several whose pools may differ.
        const nameless = refusal({ kind: "limit", model: "gpt-6.1-sol", resetsAt: instant, at: filed });
        expect(refusedPoolOf(nameless, accounts)).toEqual({ pool: "seven_day" });
        expect(refusedPoolOf(nameless, [...accounts, { account: "b", usage: codex(filed - 60_000, instant + 60) }])).toEqual({});
        // An account with no reading, or another account's.
        expect(refusedPoolOf(sol, [{ account: "a" }])).toEqual({});
        expect(refusedPoolOf({ ...sol, account: "gone" }, accounts)).toEqual({});
        // A pool the model spends that publishes no reset, or no length, or whose window closed before the refusal came:
        // the instant may be that pool's, so no pool of its own is concluded. One resetting at the instant still is it.
        const idle = at(filed - 60_000, window({ kind: "five_hour", utilization: 0 }), window({ kind: "seven_day", utilization: 30, resetsAt: instant - 2 * DAY }));
        expect(refusedPoolOf(sol, [{ account: "a", usage: idle }])).toEqual({});
        const unnamedLength = at(filed - 60_000, window({ kind: "claude:tangelo", utilization: 30, resetsAt: instant - 2 * DAY }));
        expect(refusedPoolOf(sol, [{ account: "a", usage: unnamedLength }])).toEqual({});
        const idleAtInstant = at(filed - 60_000, window({ kind: "five_hour", utilization: 0 }), window({ kind: "seven_day", utilization: 30, resetsAt: instant }));
        expect(refusedPoolOf(sol, [{ account: "a", usage: idleAtInstant }])).toEqual({ pool: "seven_day" });
        const closed = at(
            filed - 6 * 3_600_000,
            window({ kind: "five_hour", utilization: 90, resetsAt: Math.floor(filed / 1000) - 600 }),
            window({ kind: "seven_day", utilization: 30, resetsAt: instant - 2 * DAY }),
        );
        expect(refusedPoolOf(sol, [{ account: "a", usage: closed }])).toEqual({});
    });
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
    const a = refusal({ kind: "limit", account: "a", model: "sol", resetsAt: 8_000, at: 6_000 });
    const b = refusal({ kind: "limit", account: "b", model: "sol", resetsAt: 7_000, at: 6_000 });
    expect(fleetCapacity(accounts, [a, b], { id: "sol" }, 6_000_000)).toEqual({ kind: "spent", accounts: 2, reopensAt: 7_000, pool: undefined });
    expect(fleetCapacity(accounts, [a], { id: "sol" }, 6_000_000)).toEqual({ kind: "serving", serving: 1, accounts: 2, roomMeasuredAt: 5_000 });
    // An account nothing has measured may still answer: it keeps the model servable.
    expect(fleetCapacity([...accounts, { account: "c" }], [a, b], { id: "sol" }, 6_000_000)).toEqual({ kind: "serving", serving: 1, accounts: 3, roomMeasuredAt: undefined });
    // No account at all says nothing either way.
    expect(fleetCapacity([], [a], { id: "sol" }, Date.now())).toEqual({ kind: "unknown" });
    // A plan that publishes no reading (Cursor's) is spent for a model every account refused, and only that model.
    const cursor = [{ account: "x" }, { account: "y" }];
    const refused = [refusal({ kind: "limit", account: "x", model: "composer-2.5" }), refusal({ kind: "limit", account: "y", model: "composer-2.5" })];
    expect(fleetCapacity(cursor, refused, { id: "composer-2.5" }, 2_000).kind).toBe("spent");
    expect(fleetCapacity(cursor, refused, { id: "gpt-6" }, 2_000).kind).toBe("serving");
    // An account refused outright is blocked for every model.
    expect(fleetCapacity([{ account: "x" }], [refusal({ kind: "entitlement", account: "x" })], { id: "gpt-6" }, 2_000).kind).toBe("spent");
});

test("an account whose plan does not include a model is outside that model's fleet, and only that model's", () => {
    // 2026-11-19: two ChatGPT Free sign-ins back from their monthly reset, and the Team one, the only one running Sol, spent.
    const free = at(5_000, window({ kind: "monthly", utilization: 0, resetsAt: 9_000_000 }));
    const spentTeam = at(5_000, window({ kind: "five_hour", utilization: 100, resetsAt: 9_000 }));
    const freeModels = ["gpt-6-luna", "gpt-6.1-terra"];
    const accounts: ServiceFacts[] = [
        { account: "free-a", usage: free, models: freeModels },
        { account: "free-b", usage: free, models: freeModels },
        { account: "team", usage: spentTeam, models: ["gpt-6.2-sol", ...freeModels] },
    ];
    const sol = serviceStates(accounts, [], { id: "gpt-6.2-sol", label: "GPT-6.2-Sol" }, 6_000_000);
    expect(sol.get("free-a")).toEqual({ kind: "blocked", fix: "plan", reason: "GPT-6.2-Sol is not on this account's plan" });
    expect(sol.get("team")?.kind).toBe("spent");
    // Sol is back when the Team account is, and the Free ones are not counted toward it.
    expect(fleetCapacity(accounts, [], { id: "gpt-6.2-sol" }, 6_000_000)).toEqual({ kind: "spent", accounts: 1, reopensAt: 9_000, pool: undefined });
    // Every account runs Luna: the Free ones' room serves it.
    expect(fleetCapacity(accounts, [], { id: "gpt-6-luna" }, 6_000_000)).toEqual({ kind: "serving", serving: 2, accounts: 3, roomMeasuredAt: 5_000 });
    // With no model asked about, nothing is off any plan.
    expect(serviceStates(accounts, [], undefined, 6_000_000).get("free-a")?.kind).toBe("ready");
    // A model no account lists under this id (an alias, a suffix) judges nobody off plan, and neither does a missing list.
    expect(serviceStates(accounts, [], { id: "gpt-6.2-sol-high" }, 6_000_000).get("free-a")?.kind).toBe("ready");
    const unlisted = [{ account: "fresh", usage: free }, ...accounts];
    expect(serviceStates(unlisted, [], { id: "gpt-6.2-sol" }, 6_000_000).get("fresh")?.kind).toBe("ready");
    expect(fleetCapacity(unlisted, [], { id: "gpt-6.2-sol" }, 6_000_000)).toMatchObject({ kind: "serving", serving: 1, accounts: 2 });
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

// The daemon's pick and every window that draws where a turn runs read this one rule over the switch-offs the refusals
// feed carries; the window that lacked them ticked a flapping account the daemon placed nothing on (2026-11-15).
test("an account switched off twice within the week flaps; once, or twice a week apart, it does not, and a switch-off ages out on the clock", () => {
    const now = 1_800_000_000_000;
    const day = 86_400_000;
    const offs = { twice: [now - 3 * day, now - day], once: [now - day], apart: [now - FLAPPING_WINDOW_MS - day, now - day] };
    expect([...flappingAccounts(offs, now)]).toEqual(["twice"]);
    expect([...flappingAccounts(offs, now + FLAPPING_WINDOW_MS)]).toEqual([]);
    expect([...flappingAccounts(undefined, now)]).toEqual([]);
});

// 2026-11-19: the daemon lapsed a window past its reset as it read its store, the rule did not, and an editor holding
// the facts it had been sent judged the same account spent, "back at 12:00", five minutes after 12:00, while the daemon
// judged it ready. The rule now takes every reading as it stands at the instant it judges, so both sides agree.
test("a reading judged after its window resets reads the same whether or not anyone lapsed it first", () => {
    const reset = Date.parse("2026-11-19T12:00:00Z") / 1000;
    const read = (reset - 30 * 60) * 1000;
    const held = at(
        read,
        window({ kind: "five_hour", label: "5-hour", utilization: 100, resetsAt: reset }),
        window({ kind: "seven_day", label: "Weekly", utilization: 40, resetsAt: reset + 4 * 86_400 }),
    );
    const refused = refusal({ kind: "limit", account: "a", model: "gpt-x", at: read + 60_000, resetsAt: reset });
    const after = (reset + 5 * 60) * 1000;
    const asSent = serviceStates([{ account: "a", usage: held }], [refused], { id: "gpt-x" }, after).get("a");
    const asStored = serviceStates([{ account: "a", usage: { ...held, windows: currentWindows(held, after) } }], [refused], { id: "gpt-x" }, after).get("a");
    expect(asSent).toEqual({ kind: "ready", room: 60, renewsAt: reset + 4 * 86_400 });
    expect(asStored).toEqual(asSent);
    expect(fleetCapacity([{ account: "a", usage: held }], [refused], { id: "gpt-x" }, after)).toEqual({ kind: "serving", serving: 1, accounts: 1, roomMeasuredAt: read });
    // A second before the reset the same facts read spent until it.
    expect(serviceStates([{ account: "a", usage: held }], [refused], { id: "gpt-x" }, reset * 1000 - 1000).get("a")).toEqual({ kind: "spent", reopensAt: reset });
    // A reading whose every window has closed says nothing about now: the account reads as unmeasured.
    expect(serviceState({ account: "a", usage: at(read, window({ kind: "five_hour", utilization: 100, resetsAt: reset })) }, [], undefined, after)).toEqual({ kind: "unknown" });
});

test("a provider's picture is valid until the soonest instant the clock alone changes any of it", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    const s = Math.floor(now / 1000);
    const reading = at(now - 60_000, window({ kind: "five_hour", utilization: 30, resetsAt: s + 7_200 }), window({ kind: "seven_day", utilization: 20, resetsAt: s + 86_400 }));
    const facts: ServiceFacts[] = [{ account: "a", usage: reading }];
    const states = serviceStates(facts, [], undefined, now);
    // The five-hour pool resetting is the first change.
    expect(capacityValidUntil(facts, states, [], undefined, now)).toBe((s + 7_200) * 1000);
    // A refusal's own instant, a bench's end and a switch-off ageing out each come sooner when they do.
    const refused = refusal({ kind: "limit", account: "a", at: now - 1_000, resetsAt: s + 600 });
    expect(capacityValidUntil(facts, serviceStates(facts, [refused], undefined, now), [refused], undefined, now)).toBe((s + 600) * 1000);
    const benched: ServiceFacts[] = [{ account: "a", usage: reading, cooling: { until: s + 300 } }];
    expect(capacityValidUntil(benched, serviceStates(benched, [], undefined, now), [], undefined, now)).toBe((s + 300) * 1000);
    const switchedOff = now - FLAPPING_WINDOW_MS + 120_000;
    expect(capacityValidUntil(facts, states, [], { a: [switchedOff] }, now)).toBe(switchedOff + FLAPPING_WINDOW_MS);
    // Instants already past are judged; nothing ahead is nothing to wait for.
    expect(capacityValidUntil([{ account: "a" }], new Map(), [refusal({ kind: "limit", resetsAt: s - 1 })], undefined, now)).toBeUndefined();
});
