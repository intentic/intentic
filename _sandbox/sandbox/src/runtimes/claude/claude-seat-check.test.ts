import { CLAUDE_SEED_MODELS, type ProviderRefusal } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { ClaudeStore, StoredAccount } from "./claude-credentials.js";
import { claudeSeatProbe, FIRST_RECHECK_MS, LONGEST_RECHECK_MS, type SeatProbeFetch } from "./claude-seat-check.js";
import { BACK_ON, memoryRefusals, memorySeats, scriptedSeatCheck, STILL_OFF } from "./claude-seat-check.testing.js";

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
        const refusal: ProviderRefusal = { at: T0, kind: "entitlement", message: REFUSAL_TEXT, account: "a" };
        const refusals = { claude: refusal };
        const { check } = scriptedSeatCheck({ seats: memorySeats(seats), refusals: memoryRefusals(refusals), answer: () => BACK_ON, now: () => T0 + FIRST_RECHECK_MS });

        expect(await check.recheck("a")).toBe(true);
        expect([Object.keys(seats), Object.keys(refusals)]).toEqual([[], []]);
    });

    // A one-token answer on the smallest model says nothing about a pool that ran out.
    test("an answer leaves a spent account's limit refusal standing", async () => {
        const refusals = { claude: { at: T0, kind: "limit", message: "usage limit reached", account: "a" } satisfies ProviderRefusal };
        const { check } = scriptedSeatCheck({ seats: memorySeats(marked()), refusals: memoryRefusals(refusals), answer: () => BACK_ON, now: () => T0 + FIRST_RECHECK_MS });

        expect(await check.recheck("a")).toBe(true);
        expect(Object.keys(refusals)).toEqual(["claude"]);
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
});
