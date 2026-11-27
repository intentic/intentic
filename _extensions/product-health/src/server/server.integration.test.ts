import { type FakeExtension, fakeExtensionApi, type FakeManifest } from "@intentic/extension-api/testing";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import manifestFile from "../../intentic-extension.json";
import { z } from "zod";
import { SnapshotSchema } from "../wire.js";
import { activateServer } from "./server.js";
import { fixBase } from "./snapshot.js";

/* The backend as the daemon's extension host runs it, on the real extension api against a fake daemon that judges every
   call by this manifest's reach (`permissions.daemon`), reading a stand-in PostHog over real HTTP: a round's findings
   served to the view, Fix with agent starting the turn as the presser, a write held to a maintainer and landing in
   PostHog, the agent's tools, and the alert door refusing a stranger. */

// SAFETY: the manifest as this extension ships it, which the editor's builtins test parses with the daemon's own schema;
// JSON reads its lists' literals as strings.
const manifest = manifestFile as FakeManifest;

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

interface PostHog {
    readonly server: ReturnType<typeof Bun.serve>;
    // Every write PostHog was asked for, `METHOD path body`.
    readonly writes: string[];
}

// The owner's project as PostHog answered on 2026-11-26: one critical health check and one active error.
const postHog = (): PostHog => {
    const writes: string[] = [];
    const page = (results: readonly object[]) => Response.json({ count: results.length, next: null, results });
    const server = Bun.serve({
        port: 0,
        fetch: async (request) => {
            const { pathname } = new URL(request.url);
            if (request.headers.get(`authorization`) !== `Bearer phx_owner`) {
                return Response.json({ detail: `invalid key` }, { status: 401 });
            }
            if (request.method !== `GET` && !pathname.includes(`/query/`)) {
                writes.push(`${request.method} ${pathname} ${await request.text()}`);
                return Response.json({});
            }
            const routes = new Map<string, () => Response>(Object.entries({
                "/api/projects/503597/": () => Response.json({ id: 503597, name: `Default project` }),
                "/api/projects/503597/health_issues/": () =>
                    page([{ id: `h1`, kind: `sdk_outdated`, severity: `critical`, status: `active`, dismissed: false, payload: { sdk_name: `web`, current_version: `1.436.1` }, created_at: `2026-11-06T08:44:56Z` }]),
                "/api/projects/503597/health_issues/h1/": () =>
                    Response.json({ id: `h1`, kind: `sdk_outdated`, severity: `critical`, status: `active`, title: `web SDK is outdated`, summary: `behind`, link: `/health/sdk-health`, remediation: { human: `h`, agent: `Update the SDK.` } }),
                "/api/projects/503597/error_tracking/query/issues/": () =>
                    page([{ id: `e1`, name: `TypeError`, description: `boom`, status: `active`, first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), aggregations: { occurrences: 3, users: 2, sessions: 2 } }]),
                "/api/projects/503597/error_tracking/query/issue/": () => Response.json({ id: `e1`, name: `TypeError`, status: `active` }),
                "/api/projects/503597/alerts/": () => page([]),
                "/api/projects/503597/signals/reports/": () => page([]),
                "/api/projects/503597/error_tracking/recommendations/": () => Response.json([]),
                "/api/projects/503597/experiments/": () => page([]),
                "/api/projects/503597/hog_functions/": () => page([]),
            }));
            return routes.get(pathname)?.() ?? Response.json({ detail: `not found` }, { status: 404 });
        },
    });
    return { server, writes };
};

// What a test reads of a POST /agent body.
const TurnSchema = z.looseObject({ conversationId: z.string().optional(), job: z.string().optional(), isolated: z.boolean().optional(), outsideWake: z.string().optional(), prompt: z.string().optional() });

interface Daemon {
    readonly said: { readonly conversationId?: string; readonly job?: string; readonly isolated?: boolean; readonly outsideWake?: string; readonly prompt?: string }[];
    readonly agents: AgentSummary[];
}

const daemonOf = (state: Daemon, host: string) => async (request: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    switch (`${request.method} ${pathname}`) {
        case `GET /capabilities`:
            return Response.json({ capabilities: [{ id: `analytics`, kind: `cli`, status: { state: `active` }, config: { provider: `posthog`, host }, secrets: [`apiKey`] }], recommendations: [] });
        case `GET /capabilities/analytics/connection`:
            return Response.json({ id: `analytics`, kind: `cli`, config: { provider: `posthog`, host, apiKey: `phx_owner`, projectId: `503597` } });
        case `GET /workspace/repos`:
            return Response.json({ repos: [] });
        case `GET /agents`:
            return Response.json({ agents: state.agents, rev: state.agents.length });
        case `GET /agents/archived`:
            return Response.json({ agents: [], rev: 1 });
        case `POST /agent`: {
            const turn = TurnSchema.parse(await request.json());
            state.said.push(turn);
            state.agents.push({ id: turn.conversationId ?? `x`, status: `running`, provider: `claude`, harness: `native`, attention: { ...NO_ATTENTION }, updatedAt: 1 });
            return Response.json({ delivered: `started`, run: `r1` });
        }
        default:
            return undefined;
    }
};

const ready = async (): Promise<{ readonly fake: FakeExtension; readonly daemon: Daemon; readonly ph: PostHog }> => {
    const ph = postHog();
    const daemon: Daemon = { said: [], agents: [] };
    const fake = await fakeExtensionApi({ manifest, daemon: daemonOf(daemon, `http://127.0.0.1:${ph.server.port}`) });
    await fake.activate({ activateServer });
    return { fake, daemon, ph };
};

const done = async ({ fake, ph }: { readonly fake: FakeExtension; readonly ph: PostHog }): Promise<void> => {
    await fake.deactivate();
    await fake.dispose();
    await ph.server.stop(true);
};

test(`a round's findings reach the view, with PostHog's page on the real host and nothing owed to an agent yet`, async () => {
    const world = await ready();
    try {
        const snapshot = SnapshotSchema.parse(await (await world.fake.route(`/refresh`, { method: `POST` })).json());
        expect(snapshot.connections).toMatchObject([{ id: `analytics`, project: `Default project`, problems: [], wired: false }]);
        expect(snapshot.findings.map((finding) => [finding.id, finding.severity, finding.agent])).toEqual([
            [`analytics:health:h1`, `critical`, undefined],
            [`analytics:error:e1`, `warning`, undefined],
        ]);
        expect(snapshot.findings[0]?.link).toBe(`http://127.0.0.1:${world.ph.server.port}/project/503597/health/sdk-health`);
    } finally {
        await done(world);
    }
});

test(`Fix with agent starts an isolated turn as the presser, on the derived id, carrying outside words; a second press opens nothing new`, async () => {
    const world = await ready();
    try {
        await world.fake.route(`/refresh`, { method: `POST` });
        const pressed = await world.fake.route(`/findings/${encodeURIComponent(`analytics:health:h1`)}/fix`, { method: `POST`, body: `{}` }, { caller: { kind: `person`, email: `dev@example.com`, tier: `collaborator` } });
        expect(await pressed.json()).toEqual({ conversationId: fixBase(`analytics:health:h1`) });
        expect(world.daemon.said).toMatchObject([{ conversationId: fixBase(`analytics:health:h1`), job: `product-health-fix`, isolated: true, outsideWake: `PostHog` }]);
        expect(world.daemon.said[0]?.prompt).toContain(`Update the SDK.`);
        const again = await world.fake.route(`/findings/${encodeURIComponent(`analytics:health:h1`)}/fix`, { method: `POST`, body: `{}` });
        expect(again.status).toBe(409);
        expect(world.daemon.said).toHaveLength(1);
        const snapshot = SnapshotSchema.parse(await (await world.fake.route(`/snapshot`)).json());
        expect(snapshot.findings.find((finding) => finding.id === `analytics:health:h1`)?.agent).toMatchObject({ stance: `working` });
    } finally {
        await done(world);
    }
});

test(`marking fixed is a maintainer's, lands in PostHog, and remembers when`, async () => {
    const world = await ready();
    try {
        await world.fake.route(`/refresh`, { method: `POST` });
        const path = `/findings/${encodeURIComponent(`analytics:error:e1`)}/resolve`;
        const refused = await world.fake.route(path, { method: `POST` }, { caller: { kind: `person`, email: `dev@example.com`, tier: `writer` } });
        expect(refused.status).toBe(403);
        expect(world.ph.writes).toEqual([]);
        expect((await world.fake.route(path, { method: `POST` })).status).toBe(200);
        expect(world.ph.writes).toEqual([`PATCH /api/projects/503597/error_tracking/issues/e1/ {"status":"resolved"}`]);
    } finally {
        await done(world);
    }
});

test(`the agent's tools list the findings and hand over one's brief`, async () => {
    const world = await ready();
    try {
        await world.fake.route(`/refresh`, { method: `POST` });
        expect((await world.fake.tools()).map((tool) => [tool.name, tool.effect])).toEqual([
            [`findings`, `read`],
            [`finding_brief`, `read`],
        ]);
        const listed = String(await world.fake.callTool(`findings`, {}));
        expect(listed).toContain(`[critical] health "web SDK is outdated" (fix, owed: unowned)`);
        expect(String(await world.fake.callTool(`finding_brief`, { id: `analytics:health:h1` }))).toContain(`PostHog's own guidance`);
    } finally {
        await done(world);
    }
});

test(`the alert door takes only this backend's token, and never reads the body`, async () => {
    const world = await ready();
    try {
        const stranger = await world.fake.publicRoute(`hook/guessed`, { method: `POST`, body: `{"x":1}` });
        expect(stranger.status).toBe(404);
    } finally {
        await done(world);
    }
});
