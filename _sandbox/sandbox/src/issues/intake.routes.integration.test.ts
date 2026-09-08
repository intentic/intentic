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
import { fileTurnJournal } from "../agent/run/turn/turn-journal.js";
import { automationConfig } from "../harness/route-stores.testing.js";
import { fileHeldWakesStore } from "../automations/held-wakes-store.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import type { WakeFn } from "../automations/scheduler.js";
import { memoryDoorTokens } from "../auth/door-tokens.js";
import type { Services } from "../composition.js";
import { fileThreadSessionsStore } from "../sessions/thread-sessions.js";
import { createIntakeRoutes } from "./intake.routes.js";
import { fileIssuesStore, type IssuesStore } from "./issues-store.js";

// Public ingest end to end: one of two doors a stranger can reach. What matters is the refusals and the arithmetic of
// waking, a crash loop must cost file writes, not agent turns.

const ORIGIN = "https://shop.example";

const fakeServices = (root: string, appends: ActivityEvent[]): Services =>
    unstubbed<Services>("services", {
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        doorTokens: memoryDoorTokens(),
        heldWakes: fileHeldWakesStore(join(root, "approvals")),
        threadSessions: fileThreadSessionsStore(join(root, "thread-sessions.json")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async (event) => void appends.push(event as ActivityEvent), list: async () => [] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
        members: { list: async () => [], add: async () => {}, remove: async () => {} },
        // Fire-and-forget notify; a missing stub would surface as an unhandled rejection in a later test.
        pushSender: unstubbed<Services["pushSender"]>("pushSender", {
            notify: async () => ({ delivered: 0, failed: 0 }),
            notifyIfAway: async () => ({ delivered: 0, failed: 0 }),
        }),
        // Admission defaults to `hold` for this source; set to `allow` here since most tests below expect a turn to
        // run.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ admission: { issues: "allow" } }),
        }),
    });

const fakeWake = (turns: AgentTurn[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        turns.push(input);
        yield* events;
    };

const intake = (id: string, extra: Partial<Automation> = {}): Automation =>
    automationConfig(id, { trigger: { kind: "listener", provider: "issues", allowedOrigins: [ORIGIN] }, prompt: `fix:${id}`, ...extra });

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

// The wake runs detached (nothing to await from the report), so tests drain it. Waits for the expected condition (file
// writes, not a microtask hop) up to a deadline; a short fixed drain is the only option when asserting nothing woke.
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
    expect(body.id).toMatch(/^[0-9a-f]{16}$/);
    await settled(() => turns.length === 1);

    expect(await issues.read(body.id)).toMatchObject({ count: 1, kind: "crash", origin: ORIGIN, release: "a1b2c3d", automationId: "bugs" });
    expect(appends[0]).toMatchObject({ provider: "issues", direction: "in", type: "issue.new" });
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
    // Sealed both ways: inside the envelope the model reads, and flagged for the guard layer independently.
    const sealed = /<untrusted-content source="issues" id="([0-9a-f]{16})">\n([\s\S]*)\n<\/untrusted-content id="\1">/.exec(prompt);
    const brief = JSON.parse(sealed?.[2] ?? "{}") as Record<string, unknown>;
    expect(brief).toMatchObject({ why: "new", count: 1, release: "a1b2c3d", site: ORIGIN });
    // Untrusted evidence sits under its own key, never at the top level beside recorded facts.
    expect(brief["untrusted"]).toMatchObject({ message: "TypeError: x is not a function", page: "https://shop.example/checkout" });
    expect(turns[0]?.outsideWake).toBe("issues");
});

// 200 browsers hitting one broken deploy must be one row and a handful of wakes, not 200 agent turns.
test("a crash loop is one issue with a count, and wakes only on the escalation step", async () => {
    const { services, issues } = await setup(intake("bugs", { issues: { escalateAfter: 10 } }));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns), issues);

    let id = "";
    for (let n = 0; n < 25; n += 1) {
        // A different clientId each time, simulating 25 separate browsers hitting the same bug.
        const res = await post(app, "bugs", { clientId: `browser-${n}` });
        id = ((await res.json()) as { id: string }).id;
        // Each wake finishes before the next report; the expected count (1 + n/10) is the escalation rule under test.
        await settled(() => turns.length === 1 + Math.floor(n / 10));
    }
    expect((await issues.read(id))?.count).toBe(25);
    expect(turns).toHaveLength(3);
    // One conversation across all three wakes, so context from the first read carries forward.
    expect(new Set(turns.map((turn) => turn.conversationId)).size).toBe(1);
});

// An app that puts a request id in every message would mint a fresh fingerprint per report; grouping must survive that
// by normalizing values out.
test("ids inside a message do not split one bug into many", async () => {
    const { services, issues } = await setup(intake("bugs"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns), issues);
    for (const order of [8813, 9204, 1001]) {
        await post(app, "bugs", { report: crash({ message: `Failed to load /api/orders/${order}` }) });
        // Only the first arrival is new; after that, this condition is already true on the first tick.
        await settled(() => turns.length === 1);
    }
    expect((await issues.list()).issues).toHaveLength(1);
    expect(turns).toHaveLength(1);
});

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

// keyFromBrowsers defaults off: the commonest way an intake key leaks is a public web bundle, and the origin allowlist
// is what still stops that mattering.
test("a keyless client is admitted by its key, and a browser is not, unless the owner said so", async () => {
    const { services, issues } = await setup(intake("bugs"));
    const app = appFor(services, fakeWake([]), issues);
    // Key lives in the door store, not the automation record; this is what an operator copies off the install panel.
    const key = await services.doorTokens.ensure("intake", "bugs");

    expect((await post(app, "bugs", { key }, {})).status).toBe(200);
    const wrong = await post(app, "bugs", { key: "nope" }, {});
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "this intake needs a valid key" });
    expect((await post(app, "bugs", { key }, { origin: "https://evil.example" })).status).toBe(403);

    await services.automations.upsert(intake("open-bugs", { issues: { keyFromBrowsers: true } }));
    const openKey = await services.doorTokens.ensure("intake", "open-bugs");
    expect((await post(app, "open-bugs", { key: openKey }, { origin: "https://evil.example" })).status).toBe(200);
});

test("a disabled intake and an unknown one answer differently, because they are different things to fix", async () => {
    const { services, issues } = await setup(intake("bugs", { enabled: false }));
    const app = appFor(services, fakeWake([]), issues);
    expect((await post(app, "bugs", {})).status).toBe(409);
    expect((await post(app, "nope", {})).status).toBe(404);
    // A Front Desk id is not an intake id: the two public surfaces do not answer for each other.
    await services.automations.upsert(automationConfig("chat", { trigger: { kind: "listener", provider: "webchat" }, prompt: "hi" }));
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
    // Own intake id: the budget is per-automation, module-level, so sharing one would leak other tests' counts.
    const { services, issues } = await setup(intake("capped", { issues: { dailyReportMax: 2 } }));
    const app = appFor(services, fakeWake([]), issues);
    expect((await post(app, "capped", { clientId: "a" })).status).toBe(200);
    expect((await post(app, "capped", { clientId: "b", report: crash({ message: "another" }) })).status).toBe(200);
    const over = await post(app, "capped", { clientId: "c", report: crash({ message: "a third" }) });
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "this intake has reached today's limit" });
});

// The trigger narrows waking, not recording, this source's one departure from the others; an owner can hear only about
// production crashes while still reading staging's, from one intake.
test("a trigger narrowed to crashes still records what people write in", async () => {
    const { services, issues } = await setup(
        intake("bugs", { trigger: { kind: "listener", provider: "issues", allowedOrigins: [ORIGIN], eventType: "crash" } }),
    );
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

// Shipped default for this source is `hold`; it must behave like every hold, parking in the held-wakes queue with its
// own conversation so an approval lands in the issue's thread.
test("the admission floor holds the wake, with the issue's own brief on the card", async () => {
    const { issues } = await setup(intake("bugs"));
    const root = mkdtempSync(join(tmpdir(), "intake-held-"));
    const base = fakeServices(root, []);
    // Same automation, but under the shipped policy rather than the fixture's deliberate allow.
    const held = unstubbed<Services>("services", {
        ...base,
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
    });
    await held.automations.upsert(intake("bugs"));
    const turns: AgentTurn[] = [];
    const app = appFor(held, fakeWake(turns), issues);

    expect((await post(app, "bugs", {})).status).toBe(200);
    // Waits on the card, not a fixed drain, so the assertion after it proves the wake decided to park, not merely that
    // time passed.
    await settled(async () => (await held.heldWakes.list()).length === 1);
    expect(turns).toEqual([]);

    const pending = await held.heldWakes.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.title).toContain("Crash: TypeError: x is not a function");
    // Minted from intake + fingerprint: recognizable on the board, lands the run in the issue's own thread.
    expect(pending[0]?.conversationId).toMatch(/^bug-bugs-[0-9a-f]{16}$/);
    expect(pending[0]?.origin).toMatchObject({ provider: "issues", automationId: "bugs" });

    // firedAt stamps the count, so the next crash doesn't queue a second card for the same bug.
    expect((await issues.list()).issues[0]?.firedAt).toBe(1);
});

test("the config route serves resolved settings and never the ingest key", async () => {
    const { services, issues } = await setup(intake("bugs", { issues: { title: "Something wrong?" } }));
    await services.doorTokens.ensure("intake", "bugs");
    const app = appFor(services, fakeWake([]), issues);
    const res = await app.request("/intake/bugs/config", { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
    const config = (await res.json()) as Record<string, unknown>;
    expect(config).toMatchObject({ automationId: "bugs", title: "Something wrong?", captureCrashes: true, antiBot: "off" });
    // Fields are named explicitly, never spread from the stored config, or a secret would leak here.
    expect(JSON.stringify(config)).not.toContain("intake_secret");
    // Origin-gated like the ingest, so an intake's wording isn't readable from anywhere on the internet.
    expect((await app.request("/intake/bugs/config", { headers: { origin: "https://evil.example" } })).status).toBe(403);
});
