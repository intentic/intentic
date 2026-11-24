import { jsonAnswer, type CliAnswer } from "../http/cli-answer.js";
import { createRouteClient, type PlatformRouteCall } from "./route-client.js";

// The directory a routed send asks: answers kept until a minute before their pass expires, a refused pass asked for once
// more, several claims named back, and an older platform still taking reports.

const NOW = Date.parse("2026-11-24T12:00:00Z");
const resolved = (over: Record<string, unknown> = {}) => ({
    scope: "drop",
    sandboxId: "bbbbbbbbbbbb",
    name: "ops",
    address: "https://sandbox-bbbbbbbbbbbb.sbx.test",
    pass: "sp1.a.b",
    expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
    ...over,
});

const client = (answers: CliAnswer[]) => {
    let clock = NOW;
    const calls: PlatformRouteCall[] = [];
    const routes = createRouteClient({
        call: async (call) => {
            calls.push(call);
            return answers.shift() ?? jsonAnswer(200, resolved());
        },
        now: () => clock,
    });
    return { ...routes, calls, advance: (ms: number) => void (clock += ms) };
};

const DROP = { scope: "drop", person: "ada@acme.test", sandbox: "ops" } as const;

test("an answer is kept per scope, person and target until a minute before its pass expires", async () => {
    const routes = client([]);
    expect(await routes.routeTo(DROP)).toMatchObject({ ok: true, value: { name: "ops", pass: "sp1.a.b" } });
    await routes.routeTo(DROP);
    expect(routes.calls).toHaveLength(1);
    expect(routes.calls[0]).toEqual({ route: "routeResolve", input: { scope: "drop", person: "ada@acme.test", sandbox: "ops" } });
    // Another person, or another scope, is another pass.
    await routes.routeTo({ ...DROP, person: "bo@acme.test" });
    await routes.routeTo({ ...DROP, scope: "read" });
    expect(routes.calls).toHaveLength(3);
    routes.advance(9 * 60_000 + 1);
    await routes.routeTo(DROP);
    expect(routes.calls).toHaveLength(4);
});

test("a pass the far side refuses in its own words is asked for once more, and an older daemon's bare refusal is not", async () => {
    const routes = client([jsonAnswer(200, resolved({ pass: "sp1.old" })), jsonAnswer(200, resolved({ pass: "sp1.new" }))]);
    const passes: string[] = [];
    const first = await routes.deliverRouted(DROP, async (target) => {
        passes.push(target.pass);
        return passes.length === 1 ? { status: 401, error: "this pass has expired" } : { status: 200, id: "ok" };
    });
    expect(first).toMatchObject({ routed: true, delivery: { status: 200 } });
    expect(passes).toEqual(["sp1.old", "sp1.new"]);

    const old = client([]);
    let tries = 0;
    const answer = await old.deliverRouted(DROP, async () => {
        tries += 1;
        return { status: 401, error: "unauthorized" };
    });
    expect(answer).toMatchObject({ routed: true, delivery: { status: 401, error: "unauthorized" } });
    expect(tries).toBe(1);
});

test("several sandboxes claiming a project is a refusal naming each of them", async () => {
    const candidates = [
        { sandboxId: "aaaaaaaaaaaa", name: "app" },
        { sandboxId: "cccccccccccc", name: "app-staging" },
    ];
    const routes = client([jsonAnswer(409, { error: "2 sandboxes you are in claim github.com/acme/app: name one with --to", candidates })]);
    const answer = await routes.routeTo({ scope: "report", project: "github.com/acme/app", person: "ada@acme.test" });
    expect(answer).toMatchObject({ ok: false, status: 409, candidates });
    expect(answer.ok ? "" : answer.message).toContain("app-staging (cccccccccccc)");
});

test("a platform without the route still takes a report through the older directory, and nothing else", async () => {
    const missing = (): CliAnswer => ({ status: 404, body: "404 Not Found", contentType: "text/plain" });
    const report = client([missing(), jsonAnswer(200, { ...resolved(), scope: undefined, project: "github.com/acme/app" })]);
    expect(await report.routeTo({ scope: "report", project: "github.com/acme/app" })).toMatchObject({ ok: true, value: { project: "github.com/acme/app" } });
    expect(report.calls.map((call) => call.route)).toEqual(["routeResolve", "projectResolve"]);

    const drop = client([missing()]);
    expect(await drop.routeTo(DROP)).toMatchObject({ ok: false, status: 404 });
    expect(drop.calls).toHaveLength(1);

    // The handler's own 404 (no claim) is an answer, not a missing route.
    const unclaimed = client([jsonAnswer(404, { error: "nobody you reach claims github.com/acme/app" })]);
    expect(await unclaimed.routeTo({ scope: "report", project: "github.com/acme/app" })).toMatchObject({ ok: false, status: 404, message: "nobody you reach claims github.com/acme/app" });
    expect(unclaimed.calls).toHaveLength(1);
});

test("an unreachable platform reads as status 0, to be tried again later", async () => {
    const routes = client([jsonAnswer(502, { error: "the platform could not be reached, nothing was sent" })]);
    expect(await routes.routeTo(DROP)).toMatchObject({ ok: false, status: 0 });
});
