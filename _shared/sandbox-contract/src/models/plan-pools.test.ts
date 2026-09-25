import {
    bindingWindow,
    gatesModel,
    gatingWindows,
    headroomState,
    preferredAccount,
    refusalVerdict,
    roomiestAccount,
    scopedWindow,
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

// Serviceability: the one verdict on whether an account can serve a turn.

const at = (measuredAt: number, ...windows: UsageWindow[]): AccountUsage => ({ windows, measuredAt });
const refusal = (over: Partial<ProviderRefusal> & Pick<ProviderRefusal, "kind">): ProviderRefusal => ({ at: 1_000, message: "no.", ...over });

test("spent is the contract's one line: 99.5% still has room, 100% is spent until its last full pool reopens", () => {
    expect(headroomState(usage(window({ kind: "five_hour", utilization: 99.5 })))).toEqual({ kind: "ready", room: 0.5 });
    expect(
        headroomState(usage(window({ kind: "five_hour", utilization: 100, resetsAt: 50 }), window({ kind: "seven_day", utilization: 100, resetsAt: 900 }))),
    ).toEqual({ kind: "spent", reopensAt: 900 });
    expect(headroomState(usage(window({ kind: "five_hour", utilization: 100 })))).toEqual({ kind: "spent" });
    expect(headroomState(undefined)).toEqual({ kind: "unknown" });
    expect(headroomState(CLAUDE, { id: "claude-haiku-4-5" })).toEqual({ kind: "ready", room: 70 });
    expect(headroomState(CLAUDE, { id: "claude-opus-4-6" })).toEqual({ kind: "spent" });
});

test("with no model named, an account is spent only when no model can run on it", () => {
    // A full Opus slice leaves every other model the room of the fullest pool still open.
    expect(headroomState(CLAUDE)).toEqual({ kind: "ready", room: 70 });
    expect(headroomState(GOOGLE)).toEqual({ kind: "ready", room: 73 });
    // A pool gating every model, full: nothing runs, and it reopens with that pool.
    expect(headroomState(usage(window({ kind: "seven_day", utilization: 100, resetsAt: 900 }), window({ kind: "model:Opus", utilization: 10, gates: { models: ["Opus"] } })))).toEqual({
        kind: "spent",
        reopensAt: 900,
    });
    // Every slice full: the first to reopen lets some model run again.
    expect(
        headroomState(
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
    // A bench whose instant has passed is over.
    expect(serviceState({ ...facts, cooling: { until: 999 } }, undefined, undefined, 1_000_000)).toEqual({ kind: "ready", room: 100 });
});

test("a standing refusal blocks by its kind, and a limit refusal pins only the pool its model spends", () => {
    const facts = { account: "a", usage: CLAUDE };
    expect(serviceState(facts, refusal({ kind: "auth" }))).toEqual({ kind: "blocked", fix: "reconnect", reason: "no." });
    expect(serviceState(facts, refusal({ kind: "entitlement" }))).toEqual({ kind: "blocked", fix: "admin", reason: "no." });
    // Refused on Haiku: the 5-hour/weekly binding pool (seven_day, 30%) reads full, so Haiku is spent too.
    expect(serviceState(facts, refusal({ kind: "limit", model: "claude-haiku-4-5" }), { id: "claude-haiku-4-5" })).toEqual({ kind: "spent" });
    // Refused on Opus: its own slice was already full; Haiku keeps the room its pools show.
    expect(serviceState(facts, refusal({ kind: "limit", model: "claude-opus-4-6" }), { id: "claude-haiku-4-5" })).toEqual({ kind: "ready", room: 70 });
    // No reading at all: the refusal is the evidence, unless it was about another model.
    expect(serviceState({ account: "a" }, refusal({ kind: "limit" }))).toEqual({ kind: "spent" });
    expect(serviceState({ account: "a" }, refusal({ kind: "limit", model: "opus" }), { id: "haiku" })).toEqual({ kind: "unknown" });
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

test("a provider's accounts are judged together: a standing refusal lands only on the account it names", () => {
    const room = at(500, window({ kind: "five_hour", utilization: 40 }));
    const states = serviceStates([{ account: "a", usage: room }, { account: "b", usage: room }], refusal({ kind: "entitlement", account: "a" }));
    expect(Object.fromEntries(states)).toEqual({ a: { kind: "blocked", fix: "admin", reason: "no." }, b: { kind: "ready", room: 60 } });
    const answered = serviceStates([{ account: "a", usage: at(2_000, window({ kind: "five_hour", utilization: 40 })) }], refusal({ kind: "limit", account: "a" }));
    expect(answered.get("a")).toEqual({ kind: "ready", room: 60 });
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
