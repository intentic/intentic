import { type ServerType, serve } from "@hono/node-server";
import { HISTORY_ROOT } from "@intentic/constants";
import { RUNNER_FLEET_CONVERSATION_HEADER } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import type { AppEnv } from "../../app-env.js";
import { turnProof } from "../../seams/workload-stamp.js";
import { type ParentFleetRead, parentFleetRead, relayFleetToParent } from "./parent-fleet.js";
import { runnerFleetDoor } from "./runner-fleet.routes.js";

/* A turn the parent placed on a runner reads the fleet at the parent: both halves over real HTTP, the parent's door
   (runner-fleet.routes.ts) answering for a conversation placed on the runner whose token it is, and the runner's relay
   (parent-fleet.ts) handing its turns' reads there, or keeping them here where the parent says the conversation is not
   one it placed. */

const PLACED = "fair-sage-ey2r";

// The parent: one enrolled runner, `omen`, which the parent placed PLACED on; the read stands in for the fleet's own and
// says which conversation it was asked for and with what query.
interface ParentSeen {
    readonly conversation: string | undefined;
    readonly path: string;
    readonly query: Record<string, string>;
}
let parent: ServerType;
let parentUrl: string;
let seen: ParentSeen[];
// Set by a test to stand the parent in for one too old to have the door: every path a bare 404.
let doorless = false;

const parentApp = (): Hono<AppEnv> => {
    const services = {
        runners: { verify: async (token: string | undefined) => (token === "omen-token" ? { kind: "enrolled", id: "omen" } : { kind: "unknown" }) },
        agents: {
            entry: (id: string) =>
                id === PLACED ? { id, placement: { kind: "worktree", runner: "omen", repos: [] } } : { id, placement: { kind: "main" } },
        },
    };
    const read = async (c: Parameters<Parameters<typeof runnerFleetDoor>[1]>[0]): Promise<Response> => {
        seen.push({ conversation: c.req.header(RUNNER_FLEET_CONVERSATION_HEADER), path: c.req.path, query: c.req.query() });
        return c.json({ agents: [{ id: "other-convo-1" }, { id: PLACED }], total: 2 });
    };
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => (doorless ? c.text("Not Found", 404) : await next()));
    // SAFETY: the door reads only the two services stubbed above.
    const door = runnerFleetDoor(services as never, read);
    app.get("/system/runners/fleet", door);
    app.get("/system/runners/fleet/:handle", door);
    return app;
};

beforeAll(async () => {
    parent = await new Promise<ServerType>((resolve) => {
        const server = serve({ fetch: parentApp().fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(server));
    });
    // SAFETY: a server listening on TCP returns an AddressInfo.
    parentUrl = `http://127.0.0.1:${(parent.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => parent.close(() => resolve()));
});

beforeEach(() => {
    seen = [];
    doorless = false;
});

// This runner's checkouts, and the workspace-relative path one of them names, as the fleet routes hand it in.
const CHECKOUTS = `${HISTORY_ROOT}/worktrees`;
const relative = (path: string): string => (path.startsWith(`${CHECKOUTS}/`) ? path.slice(CHECKOUTS.length + 1).split("/").slice(1).join("/") : path);

// The runner: its relay in front of a local read that says it was read here, as the fleet routes put it (fleet.routes.ts).
const runner = (fleet: ParentFleetRead | undefined, warned: string[] = []): Hono<AppEnv> => {
    const services = {
        runnerParent: { current: fleet === undefined ? undefined : { resolve: async () => ({ ok: false, message: "unused" }), fleet } },
        logger: { warn: (_data: object, message: string) => warned.push(message) },
    };
    const app = new Hono<AppEnv>();
    const answer = async (c: Parameters<typeof relayFleetToParent>[1]): Promise<Response> =>
        // SAFETY: the relay reads only the two services stubbed above.
        (await relayFleetToParent(services as never, c, relative)) ?? c.json({ agents: [{ id: "read-here" }] });
    app.get("/fleet", answer);
    app.get("/fleet/:handle", answer);
    return app;
};

const enrolled = (token = "omen-token") => parentFleetRead({ parentUrl, id: "omen", token, enrolledAt: 0 });

// A turn's shell asking, as the `agents` command does: its conversation and the proof only this daemon run can make.
const asTurn = (conversation: string) => ({ headers: { "x-intentic-conversation": conversation, "x-intentic-turn-proof": turnProof(conversation) } });

test("a turn the parent placed on the runner reads the parent's whole fleet, scoped to its conversation", async () => {
    const response = await runner(enrolled()).request(`/fleet?limit=5&on=&touching=${CHECKOUTS}/fair-sage-ey2r/intentic/src/a.ts`, asTurn(PLACED));
    expect(response.status).toBe(200);
    // Marked as the parent's, so the command says the paths it prints are on the parent's machine.
    expect(await response.json()).toEqual({ agents: [{ id: "other-convo-1" }, { id: PLACED }], total: 2, answeredBy: "parent" });
    // `on` names this runner's links, never the parent's; `touching` is made relative by this runner's own layout.
    expect(seen).toEqual([{ conversation: PLACED, path: "/system/runners/fleet", query: { limit: "5", touching: "intentic/src/a.ts" } }]);
});

test("one conversation is asked of the parent by the handle the shell named", async () => {
    const response = await runner(enrolled()).request("/fleet/other-convo-1?transcript=1&last=3", asTurn(PLACED));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ conversation: PLACED, path: "/system/runners/fleet/other-convo-1", query: { transcript: "1", last: "3" } }]);
});

test("a conversation the parent did not place on this runner is read on the runner", async () => {
    const response = await runner(enrolled()).request("/fleet", asTurn("runner-own-child"));
    expect(await response.json()).toEqual({ agents: [{ id: "read-here" }] });
    expect(seen).toEqual([]);
});

test("a shell that proves no turn, or a person at the runner, is read on the runner without asking the parent", async () => {
    let asked = 0;
    const counting: ParentFleetRead = async () => {
        asked += 1;
        return { kind: "answered", status: 200, body: "{}" };
    };
    const app = runner(counting);
    for (const init of [{}, { headers: { "x-intentic-conversation": PLACED, "x-intentic-turn-proof": "f".repeat(64) } }]) {
        expect(await (await app.request("/fleet", init)).json()).toEqual({ agents: [{ id: "read-here" }] });
    }
    expect(asked).toBe(0);
});

test("a daemon that is no runner reads its own fleet", async () => {
    expect(await (await runner(undefined).request("/fleet", asTurn(PLACED))).json()).toEqual({ agents: [{ id: "read-here" }] });
});

test("a parent too old for the door, or one refusing the runner's token, leaves the read on the runner, said in its log", async () => {
    const warned: string[] = [];
    expect(await (await runner(enrolled("revoked"), warned).request("/fleet", asTurn(PLACED))).json()).toEqual({ agents: [{ id: "read-here" }] });
    doorless = true;
    expect(await (await runner(enrolled(), warned).request("/fleet", asTurn(PLACED))).json()).toEqual({ agents: [{ id: "read-here" }] });
    expect(warned).toHaveLength(2);
    expect(seen).toEqual([]);
});

test("a parent out of reach is said as such, never answered with the runner's own few conversations", async () => {
    const gone = parentFleetRead({ parentUrl: "http://127.0.0.1:1", id: "omen", token: "omen-token", enrolledAt: 0 });
    const response = await runner(gone).request("/fleet", asTurn(PLACED));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, message: expect.stringContaining("did not answer") });
});

test("the door answers a read for a conversation the parent runs itself as not placed on that runner", async () => {
    const answer = await enrolled()("", "conversation-on-main");
    expect(answer).toEqual({ kind: "not-placed" });
    expect(seen).toEqual([]);
});
