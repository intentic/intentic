import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ActivityEvent,
    type AgentEvent,
    type AgentTurn,
    type Automation,
    type IssueIngest,
    type IssueReport,
    SandboxSettingsSchema,
} from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { fileTurnJournal } from "../agent/turn-journal.js";
import { fileApprovalsStore } from "../automations/approvals-store.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { fileThreadSessionsStore } from "../sessions/thread-sessions.js";
import { createIntakeRoutes } from "./intake.routes.js";
import { fileIssuesStore, type IssuesStore } from "./issues-store.js";

/* The public ingest, end to end. This is one of two doors on this daemon a stranger can reach, so the tests
 * that matter are the refusals and the ARITHMETIC OF WAKING: a crash loop must cost file writes, not turns. */

const ORIGIN = "https://shop.example";

const fakeServices = (root: string, appends: ActivityEvent[]): Services =>
    unstubbed<Services>("services", {
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        approvals: fileApprovalsStore(join(root, "approvals")),
        threadSessions: fileThreadSessionsStore(join(root, "thread-sessions.json")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], open: async () => {}, append: async () => {} }),
        activity: { append: async (event) => void appends.push(event as ActivityEvent), list: async () => [] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
        members: { list: async () => [], add: async () => {}, remove: async () => {} },
        // A held wake notifies the owner (scheduler.ts), fire-and-forget, so a missing stub would surface only
        // as an unhandled rejection in some later test.
        pushSender: unstubbed<Services["pushSender"]>("pushSender", {
            notify: async () => ({ delivered: 0, failed: 0 }),
            notifyIfAway: async () => ({ delivered: 0, failed: 0 }),
        }),
        /* Real parsed defaults, which for THIS source means the admission floor is `hold` — so every test below
         * that expects a turn to run asserts against a policy deliberately set to allow. That is the shipped
         * default and it belongs in the fixture rather than being quietly overridden. */
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ admission: { issues: "allow" } }),
        }),
    });

const fakeWake = (turns: AgentTurn[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        turns.push(input);
        yield* events;
    };

const intake = (id: string, extra: Partial<Automation> = {}): Automation => ({
    id,
    trigger: { kind: "listener", provider: "issues", allowedOrigins: [ORIGIN] },
    prompt: `fix:${id}`,
    enabled: true,
    ...extra,
});

const crash = (over: Partial<IssueReport> = {}): IssueReport => ({
    kind: "crash",
    message: "TypeError: x is not a function",
    stack: "    at doThing (https://shop.example/assets/app.js:2:14)",
    ...over,
});

const appFor = (services: Services, wake: WakeFn, issues: IssuesStore): Hono => {
    const routes = createIntakeRoutes(services, wake, issues);
    return new Hono()
        .get("/intake/:id/config", routes.config)
        .get("/intake/:id/challenge", routes.challenge)
        .post("/intake/:id/report", routes.report);
};

const post = (app: Hono, id: string, body: Partial<IssueIngest>, headers: Record<string, string> = { origin: ORIGIN }) =>
    app.request(`/intake/${id}/report`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ clientId: "client-1", report: crash(), ...body }),
    });

const setup = async (automation: Automation) => {
    const appends: ActivityEvent[] = [];
    const root = mkdtempSync(join(tmpdir(), "intake-"));
    const services = fakeServices(root, appends);
    await services.automations.upsert(automation);
    const issues = fileIssuesStore(join(root, "issues"));
    return { services, appends, issues };
};

/* The wake is started detached (the reporting page may be seconds from unloading and has nothing to wait on),
 * so a test that asserts on it has to let that chain drain first.
 *
 * IT IS A CHAIN OF FILE WRITES, NOT A MICROTASK HOP — a thread session opened, a run noted, an approval or a
 * fire — so a fixed sleep is a race the machine wins whenever it is busy, and a suite running every other
 * package beside it is exactly that machine. Wait for the thing that was expected to happen instead, up to a
 * deadline generous enough that only a real hang reaches it. Where the assertion is that NOTHING woke there is
 * no condition to wait for, and a short drain is the whole of what can be asked. */
const DRAIN_MS = 50;
const SETTLE_DEADLINE_MS = 5_000;
const settled = async (until?: () => boolean | Promise<boolean>): Promise<void> => {
    for (let waited = 0; waited < SETTLE_DEADLINE_MS; waited += 5) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (until === undefined ? waited >= DRAIN_MS : await until()) {
            return;
        }
    }
};

test("a report from an allowed site is stored, grouped, and answered immediately", async () => {
    const { services, appends, issues } = await setup(intake("bugs"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns), issues);

    const res = await post(app, "bugs", { report: crash({ release: "a1b2c3d", url: "https://shop.example/checkout" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    // The short reference a reporter can be given, and the id of the group it landed in.
    expect(body.id).toMatch(/^[0-9a-f]{16}$/);
    await settled(() => turns.length === 1);

    expect(await issues.read(body.id)).toMatchObject({ count: 1, kind: "crash", origin: ORIGIN, release: "a1b2c3d", automationId: "bugs" });
    expect(appends[0]).toMatchObject({ provider: "issues", direction: "in", type: "issue.new" });
    // The run is linked back, so the inbox can offer it instead of starting a second turn on the same bug.
    expect((await issues.read(body.id))?.runs).toEqual([{ conversationId: turns[0]?.conversationId, at: expect.any(Number), atCount: 1 }]);
    expect((await issues.read(body.id))?.status).toBe("investigating");
});

test("the brief the agent gets separates what we recorded from what a stranger's browser wrote", async () => {
    const { services, issues } = await setup(intake("bugs"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns), issues);
    await post(app, "bugs", { report: crash({ release: "a1b2c3d", url: "https://shop.example/checkout" }) });
    await settled(() => turns.length === 1);

    expect(turns).toHaveLength(1);
    const prompt = turns[0]?.prompt ?? "";
    expect(prompt).toContain("fix:bugs");
    /* Sealed as a stranger's words both ways: inside the envelope the model reads, and flagged to the guard
     * layer, which does not depend on the model believing it. This is a public entry point, so both halves are
     * asserted here rather than only at their own seams. */
    const sealed = /<untrusted-content source="issues" id="([0-9a-f]{16})">\n([\s\S]*)\n<\/untrusted-content id="\1">/.exec(prompt);
    const brief = JSON.parse(sealed?.[2] ?? "{}") as Record<string, unknown>;
    expect(brief).toMatchObject({ why: "new", count: 1, release: "a1b2c3d", site: ORIGIN });
    // The evidence sits under a key that says where it came from, never at the top level beside the facts.
    expect(brief["untrusted"]).toMatchObject({ message: "TypeError: x is not a function", page: "https://shop.example/checkout" });
    expect(turns[0]?.outsideWake).toBe("issues");
});

/* THE TEST THE WHOLE PRODUCT RESTS ON. Two hundred browsers hitting one broken deploy must be one row and a
 * handful of wakes, not two hundred agent turns. */
test("a crash loop is one issue with a count, and wakes only on the escalation step", async () => {
    const { services, issues } = await setup(intake("bugs", { issues: { escalateAfter: 10 } }));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns), issues);

    let id = "";
    for (let n = 0; n < 25; n += 1) {
        // A different client each time: 25 separate browsers hitting the same bug, which is what a real loop is.
        const res = await post(app, "bugs", { clientId: `browser-${n}` });
        id = ((await res.json()) as { id: string }).id;
        /* Each wake has to finish before the next report lands: `noteRun` stamps the count the wake was decided
         * at, and that stamp is the escalation rule's only memory. The step it fires on is the rule under test,
         * so it is spelled out here rather than read back off the issue — one for the fresh group, then one per
         * ten arrivals after it. */
        await settled(() => turns.length === 1 + Math.floor(n / 10));
    }
    expect((await issues.read(id))?.count).toBe(25);
    // Once when it was new, then at +10 and +20. Three, not twenty-five.
    expect(turns).toHaveLength(3);
    // All three on ONE conversation, so the agent that read the stack the first time still has it.
    expect(new Set(turns.map((turn) => turn.conversationId)).size).toBe(1);
});

/* THE OTHER HALF OF THE SAME ARITHMETIC: an app that puts a request id in every error message would mint a
 * fresh fingerprint per report, and the grouping must survive that by normalizing the values out. */
test("ids inside a message do not split one bug into many", async () => {
    const { services, issues } = await setup(intake("bugs"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns), issues);
    for (const order of [8813, 9204, 1001]) {
        await post(app, "bugs", { report: crash({ message: `Failed to load /api/orders/${order}` }) });
        // Only the first arrival is new, so one wake covers all three: after it, this returns on the first tick.
        await settled(() => turns.length === 1);
    }
    expect((await issues.list()).issues).toHaveLength(1);
    expect(turns).toHaveLength(1);
});

// Two people describing one annoyance in their own words are two things to read; a count of 2 on the first
// person's sentence would hide the second person's entirely.
test("written reports never group, so nobody's words are swallowed by a count", async () => {
    const { services, issues } = await setup(intake("bugs"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns), issues);
    for (const [index, who] of ["ann", "bo"].entries()) {
        await post(app, "bugs", { report: { kind: "report", message: "Feedback", description: "the button does nothing", reporter: { name: who } } });
        await settled(() => turns.length === index + 1);
    }
    const { issues: rows } = await issues.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.title)).toEqual(["the button does nothing", "the button does nothing"]);
    expect(turns).toHaveLength(2);
});

test("an origin nobody listed is refused, and nothing is recorded for it", async () => {
    const { services, issues } = await setup(intake("bugs"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns), issues);

    const res = await post(app, "bugs", {}, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin not allowed" });
    await settled();
    expect((await issues.list()).issues).toEqual([]);
    expect(turns).toEqual([]);
});

/* A phone or a server has no Origin header for the allowlist to read, so it presents the ingest key instead.
 * `keyFromBrowsers` stays off by default because the commonest way an intake is abused is its key ending up in
 * a public web bundle, and the allowlist is what stops that mattering. */
test("a keyless client is admitted by its key, and a browser is not, unless the owner said so", async () => {
    const { services, issues } = await setup(intake("bugs", { issues: { ingestKey: "intake_secret" } }));
    const app = appFor(services, fakeWake([]), issues);

    // No origin at all (a phone), with the key: admitted.
    expect((await post(app, "bugs", { key: "intake_secret" }, {})).status).toBe(200);
    // No origin, wrong key: refused, and told which door it was trying.
    const wrong = await post(app, "bugs", { key: "nope" }, {});
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "this intake needs a valid key" });
    // A browser on an unlisted origin cannot buy its way in with the key while `keyFromBrowsers` is off.
    expect((await post(app, "bugs", { key: "intake_secret" }, { origin: "https://evil.example" })).status).toBe(403);

    await services.automations.upsert(intake("open-bugs", { issues: { ingestKey: "intake_secret", keyFromBrowsers: true } }));
    expect((await post(app, "open-bugs", { key: "intake_secret" }, { origin: "https://evil.example" })).status).toBe(200);
});

test("a disabled intake and an unknown one answer differently, because they are different things to fix", async () => {
    const { services, issues } = await setup(intake("bugs", { enabled: false }));
    const app = appFor(services, fakeWake([]), issues);
    expect((await post(app, "bugs", {})).status).toBe(409);
    expect((await post(app, "nope", {})).status).toBe(404);
    // A Front Desk id is not an intake id: the two public surfaces do not answer for each other.
    await services.automations.upsert({ id: "chat", trigger: { kind: "listener", provider: "webchat" }, prompt: "hi", enabled: true });
    expect((await post(app, "chat", {})).status).toBe(404);
});

test("a malformed body is refused before anything is stored", async () => {
    const { services, issues } = await setup(intake("bugs"));
    const app = appFor(services, fakeWake([]), issues);
    const res = await app.request("/intake/bugs/report", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ clientId: "c", report: { kind: "meteor", message: "" } }),
    });
    expect(res.status).toBe(400);
    expect((await issues.list()).issues).toEqual([]);
});

test("the day's ceiling stops an intake spending forever", async () => {
    /* ITS OWN INTAKE ID, because the ceiling is counted per automation in a module-level budget that lives as
     * long as the daemon does (store/daily-budget.ts says why it is not persisted). Sharing an id with the
     * tests above would make this one depend on how many reports they happened to send. */
    const { services, issues } = await setup(intake("capped", { issues: { dailyReportMax: 2 } }));
    const app = appFor(services, fakeWake([]), issues);
    expect((await post(app, "capped", { clientId: "a" })).status).toBe(200);
    expect((await post(app, "capped", { clientId: "b", report: crash({ message: "another" }) })).status).toBe(200);
    const over = await post(app, "capped", { clientId: "c", report: crash({ message: "a third" }) });
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "this intake has reached today's limit" });
});

/* The trigger narrows the WAKING, not the recording, which is this source's one departure from the others: an
 * owner can hear about production crashes while still reading staging's, from one intake. */
test("a trigger narrowed to crashes still records what people write in", async () => {
    const { services, issues } = await setup(intake("bugs", { trigger: { kind: "listener", provider: "issues", allowedOrigins: [ORIGIN], eventType: "crash" } }));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns), issues);

    await post(app, "bugs", { report: { kind: "report", message: "Feedback", description: "the copy is confusing" } });
    await settled();
    expect((await issues.list()).issues).toHaveLength(1);
    expect(turns).toEqual([]);

    await post(app, "bugs", {});
    await settled(() => turns.length === 1);
    expect((await issues.list()).issues).toHaveLength(2);
    expect(turns).toHaveLength(1);
});

/* The shipped default for this source is `hold`, and it has to behave like every other hold: the wake parks in
 * the approvals queue carrying its own conversation, so approving it later lands in the issue's thread. */
test("the admission floor holds the wake, with the issue's own brief on the card", async () => {
    const { issues } = await setup(intake("bugs"));
    const root = mkdtempSync(join(tmpdir(), "intake-held-"));
    const base = fakeServices(root, []);
    // The same automation, under the SHIPPED policy rather than the fixture's deliberate allow.
    const held = unstubbed<Services>("services", {
        ...base,
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
    });
    await held.automations.upsert(intake("bugs"));
    const turns: AgentTurn[] = [];
    const app = appFor(held, fakeWake(turns), issues);

    expect((await post(app, "bugs", {})).status).toBe(200);
    // Waiting on the CARD rather than on a drain is also what makes the line under it mean anything: the wake
    // has demonstrably reached its decision, and the decision was to park rather than to run.
    await settled(async () => (await held.approvals.list()).length === 1);
    expect(turns).toEqual([]);

    const pending = await held.approvals.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.title).toContain("Crash: TypeError: x is not a function");
    /* The conversation is snapshotted on the approval, which is what makes an approved run land in the issue's
     * own thread rather than in a fresh one. Minted from the intake and the fingerprint, so it is recognizable
     * on the board and in a worktree name. */
    expect(pending[0]?.conversationId).toMatch(/^bug-bugs-[0-9a-f]{16}$/);
    expect(pending[0]?.origin).toMatchObject({ provider: "issues", automationId: "bugs" });

    // And the count is stamped, so the next crash does not queue a second card for the same bug.
    expect((await issues.list()).issues[0]?.firedAt).toBe(1);
});

test("the config route serves resolved settings and never the ingest key", async () => {
    const { services, issues } = await setup(intake("bugs", { issues: { ingestKey: "intake_secret", title: "Something wrong?" } }));
    const app = appFor(services, fakeWake([]), issues);
    const res = await app.request("/intake/bugs/config", { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
    const config = (await res.json()) as Record<string, unknown>;
    expect(config).toMatchObject({ automationId: "bugs", title: "Something wrong?", captureCrashes: true, antiBot: "off" });
    // The whole point of naming every field rather than spreading the stored config.
    expect(JSON.stringify(config)).not.toContain("intake_secret");
    // Origin-gated like the ingest, so an intake's wording is not readable from anywhere on the internet.
    expect((await app.request("/intake/bugs/config", { headers: { origin: "https://evil.example" } })).status).toBe(403);
});
