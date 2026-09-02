import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ActivityEvent,
    type AgentEvent,
    type AgentTurn,
    type Automation,
    SandboxSettingsSchema,
    WEBCHAT_DAILY_MAX_DEFAULT,
} from "@intentic/sandbox-contract";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { fileHeldWakesStore } from "../automations/held-wakes-store.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import type { WakeFn } from "../automations/scheduler.js";
import { fileTurnJournal } from "../agent/turn-journal.js";
import type { Services } from "../composition.js";
import { fileThreadSessionsStore } from "../sessions/thread-sessions.js";
import { unstubbed } from "@intentic/testing";
import { createWebchatRoutes } from "./webchat.routes.js";

const ORIGIN = "https://site.example";

const fakeServices = (root: string, appends: ActivityEvent[]): Services =>
    unstubbed<Services>("services", {
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        heldWakes: fileHeldWakesStore(join(root, "approvals")),
        threadSessions: fileThreadSessionsStore(join(root, "thread-sessions.json")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], open: async () => {}, append: async () => {} }),
        activity: { append: async (e) => void appends.push(e as ActivityEvent), list: async () => [] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
        // Identity reads the workspace's authorized emails to decide the `member` tag; an empty list is the
        // ordinary case for a public Front Desk.
        members: { list: async () => [], add: async () => {}, remove: async () => {} },
        // A held automation notifies the owner (scheduler.ts). Fire-and-forget there, so a missing stub
        // surfaces only as an unhandled rejection: loud enough to poison a later test, quiet enough to hide.
        pushSender: unstubbed<Services["pushSender"]>("pushSender", {
            notify: async () => ({ delivered: 0, failed: 0 }),
            notifyIfAway: async () => ({ delivered: 0, failed: 0 }),
        }),
        // Real parsed defaults: the admission gate reads them on every fire (all-allow out of the box), and
        // the spin-loop guard's limit defaults to 0, which keeps these tests about the Front Desk.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
    });

const fakeWake = (turns: AgentTurn[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        turns.push(input);
        yield* events;
    };

const webchat = (id: string, extra: Partial<Automation> = {}): Automation => ({
    id,
    trigger: { kind: "listener", provider: "webchat", allowedOrigins: [ORIGIN] },
    prompt: `support:${id}`,
    enabled: true,
    ...extra,
});

const appFor = (services: Services, wake: WakeFn): Hono => {
    const routes = createWebchatRoutes(services, wake);
    return new Hono()
        .get("/webchat/:id/config", routes.config)
        .get("/webchat/:id/challenge", routes.challenge)
        .post("/webchat/:id/message", routes.message)
        .get("/webchat/:id/installs", routes.installs);
};

const post = (app: Hono, id: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
    app.request(`/webchat/${id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });

const setup = async (automation: Automation) => {
    const appends: ActivityEvent[] = [];
    const services = fakeServices(mkdtempSync(join(tmpdir(), "webchat-")), appends);
    await services.automations.upsert(automation);
    return { services, appends };
};

test("an allowed visitor message wakes the agent and streams the reply back as SSE", async () => {
    const { services, appends } = await setup(webchat("wc-ok"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns, [{ kind: "delta", text: "Hel" }, { kind: "delta", text: "lo" }, { kind: "done" }]));
    const res = await post(app, "wc-ok", { conversationId: "c1", content: "fix the bug" });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: delta\ndata: Hel");
    expect(body).toContain("event: delta\ndata: lo");
    expect(body).toContain("event: done");
    // The visitor message reached the wake and a completed run was recorded.
    expect(turns[0]?.prompt).toContain("support:wc-ok");
    expect(turns[0]?.prompt).toContain("fix the bug");
    /* …and it arrived marked as a stranger's words, both ways: sealed in the envelope the model reads, and
     * flagged to the guard layer, which does not depend on the model believing it. This is the public
     * entry point, so the two halves are asserted here end-to-end rather than only at their own seams. */
    const sealed = /<untrusted-content source="webchat" id="([0-9a-f]{16})">\n([\s\S]*)\n<\/untrusted-content id="\1">/.exec(turns[0]?.prompt ?? "");
    // The visitor's whole payload rides inside one envelope: their text, and the name they chose for themselves.
    expect(JSON.parse(sealed?.[2] ?? "{}")).toMatchObject({ content: "fix the bug", author: "visitor" });
    expect(turns[0]?.outsideWake).toBe("webchat");
    expect((await services.automations.get("wc-ok"))?.runs[0]?.outcome).toBe("completed");
    // The inbound request landed in the activity feed.
    expect(appends[0]).toMatchObject({ provider: "webchat", direction: "in", type: "message.received", content: "fix the bug" });
});

test("a requireApproval automation holds the wake and streams a pending notice instead of a reply", async () => {
    const { services } = await setup(webchat("wc-gated", { requireApproval: true }));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns));
    const res = await post(app, "wc-gated", { conversationId: "c1", content: "change the header" });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("event: pending");
    // Held, not run: no prompt reached the agent and one approval is queued.
    expect(turns).toEqual([]);
    expect(await services.heldWakes.list()).toHaveLength(1);
    expect((await services.automations.get("wc-gated"))?.runs).toEqual([]);
});

/* THE HELD WAKE KEEPS THE VISITOR'S THREAD. Without the conversation on the approval the approve route has
 * nothing to resume, so it minted a fresh one, and a chat the owner approves message by message became one
 * fleet card and one worktree per message, each with an agent meeting the visitor for the first time. */
test("a held Front Desk wake snapshots the conversation the visitor's thread already owns", async () => {
    const { services } = await setup(webchat("wc-thread", { requireApproval: true }));
    const app = appFor(services, fakeWake([]));
    // Draining the SSE body is what waits for the fire: the response resolves as soon as the stream opens.
    await (await post(app, "wc-thread", { conversationId: "visitor-7", content: "hello" })).text();
    const [held] = await services.heldWakes.list();
    expect(held?.conversationId).toBe("wc-wc-thread-visitor-7");
    // The same conversation the thread store opened for this visitor, not a second one.
    const thread = await services.threadSessions.get("webchat:wc-thread:visitor-7", 60_000, Date.now());
    expect(held?.conversationId).toBe(thread?.conversationId);
});

/* THE REGRESSION THIS FILE EXISTED WITHOUT. A wake that errors records the reason on the row and in the
 * activity feed, and used to tell the visitor nothing at all: the stream closed on `done` with no text, so the
 * widget dropped its typing bubble and left the message looking unsent. */
test("a wake that errors tells the visitor so, without leaking the owner's reason", async () => {
    const { services } = await setup(webchat("wc-broken"));
    const app = appFor(services, fakeWake([], [{ kind: "error", message: "API Error: 401 OAuth access token has been revoked" }]));
    const body = await (await post(app, "wc-broken", { conversationId: "c1", content: "hi" })).text();
    expect(body).toContain("event: error");
    expect(body).toContain("Sorry: I couldn't answer that just now.");
    // The provider's sentence is the owner's to read, on the row: never the stranger's.
    expect(body).not.toContain("OAuth");
    expect((await services.automations.get("wc-broken"))?.runs[0]).toMatchObject({ outcome: "error", detail: expect.stringContaining("OAuth") });
});

/* A guard that says no is the automation working as configured, and it is STILL a reply that never comes:
 * the visitor gets the same closed stream an errored wake gives them. */
test("a guard that skips the run is said out loud rather than closing the stream in silence", async () => {
    const { services } = await setup(webchat("wc-guarded", { guard: "exit 1" }));
    const app = appFor(services, fakeWake([]));
    const body = await (await post(app, "wc-guarded", { conversationId: "c1", content: "hi" })).text();
    expect(body).toContain("event: error");
    expect((await services.automations.get("wc-guarded"))?.runs[0]?.outcome).toBe("skipped");
});

test("a disallowed or missing origin is refused before any wake", async () => {
    const { services } = await setup(webchat("wc-origin"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns));
    expect((await post(app, "wc-origin", { conversationId: "c1", content: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(app, "wc-origin", { conversationId: "c1", content: "x" }, {})).status).toBe(403);
    expect(turns).toEqual([]);
});

test("unknown id, disabled automation, and invalid body are rejected", async () => {
    const { services } = await setup(webchat("wc-guard", { enabled: false }));
    const app = appFor(services, fakeWake([]));
    expect((await post(app, "missing", { conversationId: "c1", content: "x" })).status).toBe(404);
    expect((await post(app, "wc-guard", { conversationId: "c1", content: "x" })).status).toBe(409);
    // Enable it, then send a body with no content.
    await services.automations.upsert(webchat("wc-guard"));
    expect((await post(app, "wc-guard", { conversationId: "c1" })).status).toBe(400);
});

test("a conversation is rate limited after the window fills", async () => {
    const { services } = await setup(webchat("wc-rate"));
    const app = appFor(services, fakeWake([]));
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
        const res = await post(app, "wc-rate", { conversationId: "burst", content: `m${i}` });
        await res.text();
        statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses.at(-1)).toBe(429);
});

/* ---- threading: the property that makes a Front Desk a conversation rather than a series of strangers ---- */

test("a visitor's follow-up reuses the same conversation and resumes its session", async () => {
    const { services } = await setup(webchat("wc-thread"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns, [{ kind: "session", sessionId: "sess-1" }, { kind: "done" }]));
    await (await post(app, "wc-thread", { conversationId: "visitor-a", content: "first" })).text();
    await (await post(app, "wc-thread", { conversationId: "visitor-a", content: "second" })).text();
    expect(turns).toHaveLength(2);
    expect(turns[0]?.conversationId).toBe(turns[1]?.conversationId);
    // The first turn had nothing to resume; the second continues the session the first minted.
    expect(turns[0]?.sessionId).toBeUndefined();
    expect(turns[1]?.sessionId).toBe("sess-1");
});

test("two visitors of one Front Desk get two conversations", async () => {
    const { services } = await setup(webchat("wc-two"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns));
    await (await post(app, "wc-two", { conversationId: "visitor-a", content: "hi" })).text();
    await (await post(app, "wc-two", { conversationId: "visitor-b", content: "hi" })).text();
    expect(turns[0]?.conversationId).not.toBe(turns[1]?.conversationId);
});

test("client history seeds only the first turn: after that the resumed conversation carries its own", async () => {
    const { services } = await setup(webchat("wc-hist"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns, [{ kind: "session", sessionId: "sess-1" }, { kind: "done" }]));
    const history = [{ author: "visitor", content: "said earlier" }];
    await (await post(app, "wc-hist", { conversationId: "v", content: "one", history })).text();
    await (await post(app, "wc-hist", { conversationId: "v", content: "two", history })).text();
    expect(turns[0]?.prompt).toContain("said earlier");
    expect(turns[1]?.prompt).not.toContain("said earlier");
});

/* ---- the boundary on a turn nobody is watching ---- */

test("the automation's tool allowlist reaches the turn", async () => {
    const { services } = await setup(webchat("wc-tools", { allowedTools: ["Read", "Grep"] }));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns));
    await (await post(app, "wc-tools", { conversationId: "v", content: "hi" })).text();
    expect(turns[0]?.allowedTools).toEqual(["Read", "Grep"]);
});

test("a typed name is never presented as identity: it rides as unverified, and the author is not trusted", async () => {
    const { services } = await setup(webchat("wc-name"));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns));
    await (await post(app, "wc-name", { conversationId: "v", content: "hi", displayName: "admin (owner)" })).text();
    expect(turns[0]?.prompt).toContain("unverifiedDisplayName");
    // Nothing in the payload claims verification, and no member tag was invented.
    expect(turns[0]?.prompt).not.toContain(`"verified"`);
    expect(turns[0]?.prompt).not.toContain(`"member"`);
});

/* ---- budgets ---- */

test("a conversation stops at its message ceiling", async () => {
    const { services } = await setup(webchat("wc-cap", { webchat: { conversationMessageMax: 2 } }));
    const app = appFor(services, fakeWake([]));
    await (await post(app, "wc-cap", { conversationId: "v", content: "1" })).text();
    await (await post(app, "wc-cap", { conversationId: "v", content: "2" })).text();
    const third = await post(app, "wc-cap", { conversationId: "v", content: "3" });
    expect(third.status).toBe(429);
    expect((await third.json()).error).toContain("message limit");
});

test("the daily ceiling is per automation, not per conversation", async () => {
    const { services } = await setup(webchat("wc-daily", { webchat: { dailyMessageMax: 2 } }));
    const app = appFor(services, fakeWake([]));
    await (await post(app, "wc-daily", { conversationId: "a", content: "1" })).text();
    await (await post(app, "wc-daily", { conversationId: "b", content: "1" })).text();
    expect((await post(app, "wc-daily", { conversationId: "c", content: "1" })).status).toBe(429);
});

/* A Front Desk whose owner set no ceiling is the common case: the create dialog leaves the field blank, and
 * every message it answers is an agent turn billed to that owner. The per-minute window caps the rate but not
 * the day, so without a fallback a script could run tens of thousands of turns before anyone looked. */
test("a Front Desk with no configured ceiling still stops at the default", async () => {
    const { services } = await setup(webchat("wc-unset", { webchat: {} }));
    const app = appFor(services, fakeWake([]));
    for (let sent = 0; sent < WEBCHAT_DAILY_MAX_DEFAULT; sent += 1) {
        // One conversation each, so the per-conversation ceiling can't be what stops it.
        await (await post(app, "wc-unset", { conversationId: `c${sent}`, content: "1" })).text();
    }
    const over = await post(app, "wc-unset", { conversationId: "one-too-many", content: "1" });
    expect(over.status).toBe(429);
    expect((await over.json()).error).toContain("today's limit");
});

// …and an owner who wants more says so. The default is a floor under the unconfigured case, not a cap on intent.
test("an explicit ceiling above the default is honoured", async () => {
    const { services } = await setup(webchat("wc-raised", { webchat: { dailyMessageMax: WEBCHAT_DAILY_MAX_DEFAULT + 1 } }));
    const app = appFor(services, fakeWake([]));
    for (let sent = 0; sent < WEBCHAT_DAILY_MAX_DEFAULT; sent += 1) {
        await (await post(app, "wc-raised", { conversationId: `c${sent}`, content: "1" })).text();
    }
    expect((await post(app, "wc-raised", { conversationId: "one-more", content: "1" })).status).toBe(200);
});

/* ---- the bot ceiling ---- */

test("with the proof-of-work check on, a first message without an answer is refused and a solved one gets through", async () => {
    const { services } = await setup(webchat("wc-pow", { webchat: { antiBot: "pow" } }));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns));
    expect((await post(app, "wc-pow", { conversationId: "v", content: "hi" })).status).toBe(403);

    const challenge = await (await app.request(`/webchat/wc-pow/challenge?conversation=v`, { headers: { origin: ORIGIN } })).json();
    const { createHash } = await import("node:crypto");
    let nonce = 0;
    const clears = (candidate: number): boolean => {
        const digest = createHash("sha256").update(`${challenge.salt}:${candidate}`).digest();
        let bits = 0;
        for (const byte of digest) {
            if (byte !== 0) {
                return bits + Math.clz32(byte) - 24 >= challenge.difficulty;
            }
            bits += 8;
        }
        return true;
    };
    while (!clears(nonce)) {
        nonce += 1;
    }
    const ok = await post(app, "wc-pow", { conversationId: "v", content: "hi", powNonce: `${challenge.salt}:${nonce}` });
    await ok.text();
    expect(ok.status).toBe(200);
    // Spent once per thread: the follow-up carries no answer and is admitted anyway.
    const follow = await post(app, "wc-pow", { conversationId: "v", content: "again" });
    await follow.text();
    expect(follow.status).toBe(200);
});

test("a proof-of-work answer cannot be carried to another visitor's thread", async () => {
    const { services } = await setup(webchat("wc-pow2", { webchat: { antiBot: "pow" } }));
    const app = appFor(services, fakeWake([]));
    const challenge = await (await app.request(`/webchat/wc-pow2/challenge?conversation=mine`, { headers: { origin: ORIGIN } })).json();
    const { createHash } = await import("node:crypto");
    let nonce = 0;
    while (createHash("sha256").update(`${challenge.salt}:${nonce}`).digest().readUInt16BE(0) !== 0) {
        nonce += 1;
    }
    // Solved for "mine", replayed for "theirs".
    expect((await post(app, "wc-pow2", { conversationId: "theirs", content: "hi", powNonce: `${challenge.salt}:${nonce}` })).status).toBe(403);
});

test("turnstile is verified server-side, and a rejected token never reaches a wake", async () => {
    const { services } = await setup(webchat("wc-ts", { webchat: { antiBot: "turnstile", turnstileSiteKey: "site", turnstileSecret: "secret" } }));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns));
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })),
    );
    expect((await post(app, "wc-ts", { conversationId: "v", content: "hi", turnstileToken: "bad" })).status).toBe(403);
    expect(turns).toEqual([]);
    vi.unstubAllGlobals();
});

/* ---- the config route ---- */

test("config resolves every default and never emits a secret", async () => {
    const { services } = await setup(
        webchat("wc-cfg", { webchat: { title: "Ask us", antiBot: "turnstile", turnstileSiteKey: "site-key", turnstileSecret: "SECRET-VALUE" } }),
    );
    const app = appFor(services, fakeWake([]));
    const res = await app.request(`/webchat/wc-cfg/config`, { headers: { origin: ORIGIN } });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
        automationId: "wc-cfg",
        title: "Ask us",
        position: "top-right",
        access: "public",
        antiBot: "turnstile",
        turnstileSiteKey: "site-key",
    });
    // The half of the pair that must never leave the daemon.
    expect(body).not.toContain("SECRET-VALUE");
    expect(body).not.toContain("turnstileSecret");
    // A greeting nobody set still has one, so the widget carries no fallback of its own.
    expect(JSON.parse(body).greeting).not.toBe("");
});

test("a bot check configured without its keys reports off rather than becoming a gate nobody can pass", async () => {
    const { services } = await setup(webchat("wc-half", { webchat: { antiBot: "turnstile", turnstileSiteKey: "site-key" } }));
    const app = appFor(services, fakeWake([]));
    const config = await (await app.request(`/webchat/wc-half/config`, { headers: { origin: ORIGIN } })).json();
    expect(config.antiBot).toBe("off");
    // …and the message route agrees: the same resolution decides both.
    const res = await post(app, "wc-half", { conversationId: "v", content: "hi" });
    await res.text();
    expect(res.status).toBe(200);
});

test("config and challenge are origin-gated like the message route", async () => {
    const { services } = await setup(webchat("wc-gate"));
    const app = appFor(services, fakeWake([]));
    expect((await app.request(`/webchat/wc-gate/config`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await app.request(`/webchat/wc-gate/challenge?conversation=v`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    // No Origin header at all (a curl, a scraper) is refused too.
    expect((await app.request(`/webchat/wc-gate/config`)).status).toBe(403);
});

test("sign-in-only refuses an anonymous message with 401 so the widget knows to re-open its gate", async () => {
    const { services } = await setup(webchat("wc-auth", { webchat: { access: "google", googleClientId: "client-id.apps.googleusercontent.com" } }));
    const turns: AgentTurn[] = [];
    const app = appFor(services, fakeWake(turns));
    expect((await post(app, "wc-auth", { conversationId: "v", content: "hi" })).status).toBe(401);
    // An unverifiable token is refused the same way: an expired-vs-forged breakdown only helps someone probing.
    expect((await post(app, "wc-auth", { conversationId: "v", content: "hi", idToken: "not-a-jwt" })).status).toBe(401);
    expect(turns).toEqual([]);
});

/* ---- install probes: telling "nobody has written yet" from "the snippet never landed" ---- */

test("a widget load is recorded against the origin it came from, admitted or refused", async () => {
    const { services } = await setup(webchat("wc-probe"));
    const app = appFor(services, fakeWake([]));
    await app.request(`/webchat/wc-probe/config`, { headers: { origin: ORIGIN } });
    // The commonest setup mistake: the site redirects to www, so the browser asks from an origin nobody listed.
    await app.request(`/webchat/wc-probe/config`, { headers: { origin: "https://www.site.example" } });
    await app.request(`/webchat/wc-probe/config`, { headers: { origin: "https://www.site.example" } });

    const installs = await (await app.request(`/webchat/wc-probe/installs`)).json();
    expect(installs.origins).toHaveLength(2);
    // Newest first, and the refused one carries the origin the owner has to add.
    const refused = installs.origins.find((probe: { origin: string }) => probe.origin === "https://www.site.example");
    expect(refused).toMatchObject({ allowed: false, loads: 2 });
    expect(installs.origins.find((probe: { origin: string }) => probe.origin === ORIGIN)).toMatchObject({ allowed: true, loads: 1 });
});

test("a Front Desk nobody has loaded reports no origins at all: the honest 'not installed' answer", async () => {
    const { services } = await setup(webchat("wc-silent"));
    const app = appFor(services, fakeWake([]));
    expect((await (await app.request(`/webchat/wc-silent/installs`)).json()).origins).toEqual([]);
});

test("a probe for an id that is not a Front Desk records nothing", async () => {
    const { services } = await setup(webchat("wc-real"));
    const app = appFor(services, fakeWake([]));
    await app.request(`/webchat/not-a-front-desk/config`, { headers: { origin: ORIGIN } });
    expect((await (await app.request(`/webchat/not-a-front-desk/installs`)).json()).origins).toEqual([]);
});
