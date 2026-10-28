import { CLAUDE_SEED_MODELS } from "@intentic/sandbox-contract/models/agent-catalog";
import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { unstubbed } from "@intentic/testing";
import type { ClaudeStore, StoredAccount } from "./claude-credentials.js";
import { claudeSeatProbe, FIRST_RECHECK_MS, LONGEST_RECHECK_MS, type SeatProbeFetch } from "./claude-seat-check.js";
import { BACK_ON, seededRefusals, memorySeats, scriptedSeatCheck, STILL_OFF } from "./claude-seat-check.testing.js";

// The way back for a seat mark: the probe's reading of the provider's answer, and the schedule that rations it. What
// planning does with the answer is blocked-account.test.ts's; the whole path is agent.routes'.

const REFUSAL_TEXT = "Your organization has disabled Claude subscription access for Claude Code.";
const T0 = 1_700_000_000_000;

// A store whose token has no expiry, so ensureFreshToken hands it back without reaching the refresh path.
const ACCOUNT: StoredAccount = { id: "a", connectedAt: 1, accessToken: "tok-a" };
const store = (account: StoredAccount | undefined): ClaudeStore => unstubbed<ClaudeStore>("claudeStore", { read: async () => account });

interface Asked {
    readonly url: string;
    readonly headers: Headers;
    readonly body: unknown;
}

const answering =
    (status: number, body: unknown, asked: Asked[] = []): SeatProbeFetch =>
    async (url, init) => {
        asked.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(body), { status });
    };

describe("the probe", () => {
    test("asks the Messages API as Claude Code does, for one token, and reads an answer as access", async () => {
        const asked: Asked[] = [];
        expect(await claudeSeatProbe(store(ACCOUNT), answering(200, { content: [] }, asked))("a")).toEqual({ kind: "entitled" });
        expect(asked.map(({ url, headers, body }) => ({ url, auth: headers.get("authorization"), body }))).toEqual([
            {
                url: "https://api.anthropic.com/v1/messages",
                auth: "Bearer tok-a",
                body: {
                    // The seed floor's last row, its smallest model.
                    model: CLAUDE_SEED_MODELS.at(-1)?.id,
                    max_tokens: 1,
                    system: "You are Claude Code, Anthropic's official CLI for Claude.",
                    messages: [{ role: "user", content: "ping" }],
                },
            },
        ]);
    });

    test("reads the seat's own refusal as refused, and anything else as nothing learned", async () => {
        const refused = { type: "error", error: { type: "permission_error", message: REFUSAL_TEXT } };
        expect(await claudeSeatProbe(store(ACCOUNT), answering(403, refused))("a")).toEqual({ kind: "refused", reason: REFUSAL_TEXT });
        expect(await claudeSeatProbe(store(ACCOUNT), answering(429, { error: { message: "Rate limited" } }))("a")).toEqual({ kind: "unknown", why: "Rate limited" });
        expect(await claudeSeatProbe(store(ACCOUNT), answering(500, {}))("a")).toEqual({ kind: "unknown", why: "HTTP 500" });
        expect(await claudeSeatProbe(store(undefined), answering(200, {}))("a")).toEqual({ kind: "unknown", why: "the sign-in could not be refreshed" });
    });

    // The API's own words for the switched-off seat, which the CLI reads on a 401 or 403 and prints as REFUSAL_TEXT: an
    // API body never holds the CLI's sentence.
    test("reads the API's refusal of the organisation's sign-in as the seat refused", async () => {
        const said = "OAuth authentication is currently not allowed for this organization.";
        const refused = { type: "error", error: { type: "permission_error", message: said } };
        expect(await claudeSeatProbe(store(ACCOUNT), answering(403, refused))("a")).toEqual({ kind: "refused", reason: said });
    });
});

describe("the schedule", () => {
    const marked = () => ({ a: { at: T0, reason: REFUSAL_TEXT } });

    test("waits FIRST_RECHECK_MS after the mark, then backs off to LONGEST_RECHECK_MS while the seat stays off", async () => {
        let now = T0;
        const { check, probes } = scriptedSeatCheck({ seats: memorySeats(marked()), answer: () => STILL_OFF, now: () => now });

        expect(await check.recheck("a")).toBe(false);
        expect(probes).toEqual([]);

        const asks: number[] = [];
        for (let minute = 1; minute <= 120; minute++) {
            now = T0 + minute * 60_000;
            const before = probes.length;
            await check.recheck("a");
            if (probes.length > before) {
                asks.push(minute);
            }
        }
        // 5, then gaps of 10, 20, 30, 30, …
        expect(asks).toEqual([5, 15, 35, 65, 95]);
        expect([FIRST_RECHECK_MS, LONGEST_RECHECK_MS]).toEqual([5 * 60_000, 30 * 60_000]);
    });

    test("an answer lifts the mark, and an entitlement refusal filed for the account with it", async () => {
        const seats = marked();
        const refusal: ProviderRefusal = { at: Date.now(), kind: "entitlement", message: REFUSAL_TEXT, account: "a" };
        const refusals = seededRefusals({ claude: [refusal] });
        const { check } = scriptedSeatCheck({ seats: memorySeats(seats), refusals, answer: () => BACK_ON, now: () => T0 + FIRST_RECHECK_MS });

        expect(await check.recheck("a")).toBe(true);
        expect([Object.keys(seats), await refusals.onFile()]).toEqual([[], {}]);
    });

    // A one-token answer on the smallest model says nothing about a pool that ran out.
    test("an answer leaves a spent account's limit refusal standing", async () => {
        const refusals = seededRefusals({ claude: [{ at: Date.now(), kind: "limit", message: "usage limit reached", account: "a" }] });
        const { check } = scriptedSeatCheck({ seats: memorySeats(marked()), refusals, answer: () => BACK_ON, now: () => T0 + FIRST_RECHECK_MS });

        expect(await check.recheck("a")).toBe(true);
        expect(Object.keys(await refusals.onFile())).toEqual(["claude"]);
    });

    test("a person's pick asks at once, and callers arriving together share one probe", async () => {
        const seats = marked();
        const { check, probes } = scriptedSeatCheck({ seats: memorySeats(seats), answer: () => BACK_ON, now: () => T0 });

        expect(await check.recheck("a", { force: true })).toBe(true);
        expect([probes, Object.keys(seats)]).toEqual([["a"], []]);

        const shared = scriptedSeatCheck({ seats: memorySeats(marked()), answer: () => BACK_ON, now: () => T0 });
        const both = await Promise.all([shared.check.recheck("a", { force: true }), shared.check.recheck("a", { force: true })]);
        expect([both, shared.probes]).toEqual([[true, true], ["a"]]);
    });

    test("an account with no mark is answered without asking the provider", async () => {
        const { check, probes } = scriptedSeatCheck({ seats: memorySeats({}), answer: () => STILL_OFF });
        expect(await check.recheck("a")).toBe(true);
        expect(probes).toEqual([]);
    });

    // Placed in the recent past: the ledger believes an entitlement refusal for a day, and reads one filed ahead of the
    // clock as filed when it opened.
    test("a re-test refused again files the refusal for no model, so the ledger keeps believing it while it lasts", async () => {
        const at = Date.now() - 2 * FIRST_RECHECK_MS;
        const refusals = seededRefusals();
        const { check } = scriptedSeatCheck({ seats: memorySeats({ a: { at, reason: REFUSAL_TEXT } }), refusals, answer: () => STILL_OFF, now: () => at + FIRST_RECHECK_MS });

        expect(await check.recheck("a")).toBe(false);
        expect(await refusals.onFile()).toEqual({ claude: [{ at: at + FIRST_RECHECK_MS, kind: "entitlement", message: REFUSAL_TEXT, account: "a" }] });
    });
});

// The usage read refusing an account in its organisation's words is only a hint: on 2026-10-27 it did at 19:54 and turns
// served from 21:17, and on 10-28 it did at 06:58, two hours before a turn was refused. The probe decides.
describe("a hint", () => {
    test("probes an account no mark is on at once, files what it is refused with, then leaves it to the marks' schedule", async () => {
        let now = Date.now() - 30 * 60_000;
        const hintedAt = now;
        const refusals = seededRefusals();
        const { check, probes } = scriptedSeatCheck({ seats: memorySeats({}), refusals, answer: () => STILL_OFF, now: () => now });

        expect(await check.recheck("a", { hinted: true })).toBe(false);
        expect(probes).toEqual(["a"]);
        expect(await refusals.onFile()).toEqual({ claude: [{ at: hintedAt, kind: "entitlement", message: REFUSAL_TEXT, account: "a" }] });

        now = hintedAt + 60_000;
        expect(await check.recheck("a", { hinted: true })).toBe(false);
        expect(probes).toEqual(["a"]);
        now = hintedAt + FIRST_RECHECK_MS;
        expect(await check.recheck("a", { hinted: true })).toBe(false);
        expect(probes).toEqual(["a", "a"]);
    });

    test("answered with access files nothing, and the hints that keep coming probe on a gap doubling to LONGEST_RECHECK_MS", async () => {
        let now = T0;
        const refusals = seededRefusals();
        const { check, probes } = scriptedSeatCheck({ seats: memorySeats({}), refusals, answer: () => BACK_ON, now: () => now });

        const asks: number[] = [];
        for (let minute = 0; minute <= 120; minute++) {
            now = T0 + minute * 60_000;
            const before = probes.length;
            expect(await check.recheck("a", { hinted: true })).toBe(true);
            if (probes.length > before) {
                asks.push(minute);
            }
        }
        expect(asks).toEqual([0, 5, 15, 35, 65, 95]);
        expect(await refusals.onFile()).toEqual({});
    });

    test("that arrives while a probe is out shares it", async () => {
        const { check, probes } = scriptedSeatCheck({ seats: memorySeats({}), answer: () => STILL_OFF });
        expect(await Promise.all([check.recheck("a", { hinted: true }), check.recheck("a", { hinted: true })])).toEqual([false, false]);
        expect(probes).toEqual(["a"]);
    });
});
