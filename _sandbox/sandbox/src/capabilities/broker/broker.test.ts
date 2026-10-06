import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Broker, BrokerRule, CapabilityContribution } from "@intentic/extension-manifest";
import type { SecretHostGuard } from "@intentic/sandbox-contract";
import { brokeredEnvOf, gitRewriteEnv, rawRouteEnv } from "./broker-env.js";
import { createGateway, type GatewayCard, type GatewayDeps, type GatewayUse, type RuleAsk } from "./broker-gateway.js";
import { brokerRoutes, GATEWAY_PLACEHOLDER, secretBearingEnv } from "./broker-routes.js";
import { evaluateRules, pathMatches } from "./broker-rules.js";
import { brokerSessionsFrom } from "./broker-session.js";

const sessions = brokerSessionsFrom(async () => Buffer.alloc(32, 7));

const spec = (broker: Broker, env: Record<string, string> = { SERVICE_TOKEN: "${token}", SERVICE_URL: "${url}" }): CapabilityContribution =>
    ({
        id: "service",
        kind: "cli",
        catalog: { name: "Service", description: "d", category: "c" },
        fields: [
            { key: "token", label: "Token", secret: true },
            { key: "url", label: "URL" },
        ],
        env,
        skill: "skills/service/SKILL.md",
        broker,
    }) as CapabilityContribution;

describe("broker routes", () => {
    test("expand over a card's settings, with the credential in the headers, Basic pair, path or form", () => {
        const routes = brokerRoutes(
            {
                routes: [
                    { upstream: "${url}/api/", env: "SERVICE_URL", headers: { Authorization: "Bearer ${token}" } },
                    { upstream: "https://git.example.com", basic: { username: "x-access-token", password: "${token}" }, git: true },
                    { upstream: "https://bots.example.com", env: "BOT_URL", pathPrefix: "/bot${token}" },
                    { upstream: "https://login.example.com", env: "LOGIN_URL", form: { client_secret: "${token}" } },
                ],
            },
            { token: "tok", url: "https://svc.example.com" },
        );
        expect(routes.map((route) => route.upstream.href)).toEqual([
            "https://svc.example.com/api",
            "https://git.example.com/",
            "https://bots.example.com/",
            "https://login.example.com/",
        ]);
        expect(routes[0]?.headers).toEqual({ authorization: "Bearer tok" });
        expect(routes[1]?.headers).toEqual({ authorization: `Basic ${Buffer.from("x-access-token:tok").toString("base64")}` });
        expect(routes[2]?.pathPrefix).toBe("/bottok");
        expect(routes[3]?.form).toEqual({ client_secret: "tok" });
        expect(routes.every((route) => route.fields.includes("token"))).toBe(true);
    });

    test("leave out a route whose upstream is unanswered, or whose credential would break a header", () => {
        const broker: Broker = { routes: [{ upstream: "${url}", headers: { authorization: "Bearer ${token}" } }] };
        expect(brokerRoutes(broker, { token: "tok", url: "" })).toEqual([]);
        expect(brokerRoutes(broker, { token: "tok", url: "ftp://files.example.com" })).toEqual([]);
        expect(brokerRoutes(broker, { token: "tok\r\nX-Evil: 1", url: "https://svc.example.com" })).toEqual([]);
    });

    test("name every variable whose template carries a secret field", () => {
        expect(secretBearingEnv(spec({ routes: [{ upstream: "${url}" }] }))).toEqual(new Set(["SERVICE_TOKEN"]));
    });
});

describe("gateway sessions", () => {
    test("verify what they signed and nothing altered", async () => {
        const token = await sessions.sign({ capability: "github", route: 2, upstream: "https://github.com/", conversationId: "c1" });
        expect(await sessions.verify(token)).toEqual({ capability: "github", route: 2, upstream: "https://github.com/", conversationId: "c1" });
        const [payload, signature] = token.split(".");
        const forged = Buffer.from(JSON.stringify({ i: "github", r: 2, u: "https://evil.example.com/", c: "c1" })).toString("base64url");
        expect(await sessions.verify(`${forged}.${signature ?? ""}`)).toBeUndefined();
        expect(await sessions.verify(`${payload ?? ""}.${"A".repeat(32)}`)).toBeUndefined();
        expect(await brokerSessionsFrom(async () => Buffer.alloc(32, 8)).verify(token)).toBeUndefined();
    });
});

describe("credential rules", () => {
    test("match one segment with `*` and any number with `**`", () => {
        expect(pathMatches("/repos/*/*", "/repos/acme/site")).toBe(true);
        expect(pathMatches("/repos/*/*", "/repos/acme/site/issues")).toBe(false);
        expect(pathMatches("/repos/*/*/hooks/**", "/repos/acme/site/hooks")).toBe(true);
        expect(pathMatches("/repos/*/*/hooks/**", "/repos/acme/site/hooks/1/pings")).toBe(true);
        expect(pathMatches("/user/keys/**", "/user/keys")).toBe(true);
    });

    test("let the first rule covering a request decide, and allow one none covers", () => {
        const rules: BrokerRule[] = [
            { methods: ["DELETE"], paths: ["/repos/*/*"], action: "ask", why: "deletes a repository" },
            { methods: ["DELETE"], action: "deny" },
        ];
        expect(evaluateRules(rules, "delete", "/repos/acme/site")).toEqual({ action: "ask", rule: 0, why: "deletes a repository" });
        expect(evaluateRules(rules, "DELETE", "/gists/1")).toEqual({ action: "deny", rule: 1, why: undefined });
        expect(evaluateRules(rules, "GET", "/repos/acme/site")).toEqual({ action: "allow" });
    });
});

describe("a brokered card's environment", () => {
    const broker: Broker = {
        routes: [
            { upstream: "https://api.example.com", env: "SERVICE_API_URL", headers: { authorization: "Bearer ${token}" } },
            { upstream: "https://git.example.com", basic: { username: "x", password: "${token}" }, git: true },
        ],
    };
    const config = { token: "real-secret", url: "https://svc.example.com" };

    test("holds a placeholder and gateway addresses, never the credential", async () => {
        const brokered = await brokeredEnvOf(spec(broker), config, "service", { sessions, origin: "http://127.0.0.1:8790", conversationId: "c1" });
        expect(brokered?.env["SERVICE_TOKEN"]).toBe(GATEWAY_PLACEHOLDER);
        expect(brokered?.env["SERVICE_URL"]).toBe("https://svc.example.com");
        expect(brokered?.env["SERVICE_API_URL"]).toMatch(/^http:\/\/127\.0\.0\.1:8790\/[\w-]+\.[\w-]+$/);
        expect(JSON.stringify(brokered)).not.toContain("real-secret");
        expect(brokered?.git.map((rewrite) => rewrite.upstream)).toEqual(["https://git.example.com/", "git@git.example.com:"]);
        const token = brokered?.env["SERVICE_API_URL"]?.split("/").at(-1) ?? "";
        expect(await sessions.verify(token)).toEqual({ capability: "service", route: 0, upstream: "https://api.example.com/", conversationId: "c1" });
    });

    test("points raw delivery's route variables at the service itself", () => {
        expect(rawRouteEnv(spec({ routes: [{ upstream: "https://bots.example.com", env: "BOT_URL", pathPrefix: "/bot${token}" }] }), config)).toEqual(
            {
                BOT_URL: "https://bots.example.com/botreal-secret",
            },
        );
    });

    test("folds git rewrites into git's own environment config", () => {
        expect(gitRewriteEnv([{ gateway: "http://127.0.0.1:8790/t/", upstream: "https://git.example.com/" }])).toEqual({
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "url.http://127.0.0.1:8790/t/.insteadOf",
            GIT_CONFIG_VALUE_0: "https://git.example.com/",
        });
        expect(gitRewriteEnv([])).toEqual({});
    });
});

// A real upstream on loopback, recording what reached it.
interface Seen {
    readonly method: string;
    readonly url: string;
    readonly headers: IncomingMessage["headers"];
    readonly body: string;
}

const upstreamServer = async (respond?: (seen: Seen) => { status: number; headers?: Record<string, string>; body?: string }) => {
    const seen: Seen[] = [];
    const server: Server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const entry = {
                method: request.method ?? "",
                url: request.url ?? "",
                headers: request.headers,
                body: Buffer.concat(chunks).toString("utf8"),
            };
            seen.push(entry);
            const answer = respond?.(entry) ?? { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' };
            response.writeHead(answer.status, answer.headers ?? {});
            response.end(answer.body ?? "");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    return { seen, origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

interface Harness {
    readonly deps: GatewayDeps;
    readonly asked: RuleAsk[];
    readonly uses: GatewayUse[];
    readonly gateChecks: string[];
}

const harness = (card: GatewayCard | undefined, overrides: Partial<GatewayDeps> = {}): Harness => {
    const asked: RuleAsk[] = [];
    const uses: GatewayUse[] = [];
    const gateChecks: string[] = [];
    return {
        asked,
        uses,
        gateChecks,
        deps: {
            sessions,
            card: async () => card,
            ownerRules: async () => undefined,
            hostGuards: async (): Promise<readonly SecretHostGuard[]> => [],
            credentialGate: {
                check: async (input) => {
                    gateChecks.push(`${input.lane}:${input.subject}:${input.detail ?? ""}`);
                    return { allow: true };
                },
            },
            prompts: {
                canPark: () => true,
                passed: () => false,
                ask: async (input) => {
                    asked.push(input);
                    return { allow: false, reason: "declined on the card" };
                },
            },
            used: (use) => void uses.push(use),
            ...overrides,
        },
    };
};

const addressFor = async (route: number, upstream: string, conversationId = "c1"): Promise<string> =>
    `http://127.0.0.1:8790/${await sessions.sign({ capability: "service", route, upstream, conversationId })}`;

describe("the credential gateway", () => {
    test("attaches the credential, drops the placeholder, and forwards to the declared upstream only", async () => {
        const upstream = await upstreamServer();
        try {
            const card: GatewayCard = {
                name: "Service (service)",
                config: { token: "real-secret", url: upstream.origin },
                broker: { routes: [{ upstream: "${url}/api", env: "SERVICE_URL", headers: { authorization: "Bearer ${token}" } }] },
            };
            const { deps, uses, gateChecks } = harness(card);
            const gateway = createGateway(deps);
            const base = await addressFor(0, `${upstream.origin}/api`);
            const response = await gateway(
                new Request(`${base}/repos/acme/site?per_page=5`, {
                    headers: { authorization: `Bearer ${GATEWAY_PLACEHOLDER}`, "x-custom": "kept", "accept-encoding": "gzip" },
                }),
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ ok: true });
            expect(upstream.seen).toHaveLength(1);
            expect(upstream.seen[0]?.url).toBe("/api/repos/acme/site?per_page=5");
            expect(upstream.seen[0]?.headers["authorization"]).toBe("Bearer real-secret");
            expect(upstream.seen[0]?.headers["x-custom"]).toBe("kept");
            expect(upstream.seen[0]?.headers["accept-encoding"]).not.toBe("gzip");
            expect(gateChecks).toEqual([`gateway:service:GET ${new URL(upstream.origin).host}/api/repos/acme/site`]);
            expect(uses).toEqual([
                {
                    capability: "service",
                    fields: ["token"],
                    conversationId: "c1",
                    detail: `GET ${new URL(upstream.origin).host}/api/repos/acme/site`,
                },
            ]);
        } finally {
            await upstream.close();
        }
    });

    test("refuses an address it did not sign, without touching any upstream", async () => {
        const { deps } = harness(undefined);
        const response = await createGateway(deps)(new Request("http://127.0.0.1:8790/not-a-session/user"));
        expect(response.status).toBe(404);
        expect(response.headers.get("x-intentic-gateway")).toBe("refused");
    });

    test("retires an address once the card's settings move its upstream", async () => {
        const card: GatewayCard = {
            name: "Service",
            config: { token: "t", url: "https://moved.example.com" },
            broker: { routes: [{ upstream: "${url}" }] },
        };
        const { deps } = harness(card);
        const response = await createGateway(deps)(new Request(`${await addressFor(0, "https://old.example.com/")}/x`));
        expect(response.status).toBe(410);
    });

    test("puts a path-borne credential before the agent's path", async () => {
        const upstream = await upstreamServer();
        try {
            const card: GatewayCard = {
                name: "Bot",
                config: { token: "123:abc", url: upstream.origin },
                broker: { routes: [{ upstream: "${url}", pathPrefix: "/bot${token}" }] },
            };
            const response = await createGateway(harness(card).deps)(
                new Request(`${await addressFor(0, `${upstream.origin}/`)}/sendMessage`, { method: "POST", body: "{}" }),
            );
            expect(response.status).toBe(200);
            expect(upstream.seen[0]?.url).toBe("/bot123:abc/sendMessage");
            expect(upstream.seen[0]?.body).toBe("{}");
        } finally {
            await upstream.close();
        }
    });

    test("refuses what the card's rules deny, and holds what they ask on a card", async () => {
        const upstream = await upstreamServer();
        try {
            const card: GatewayCard = {
                name: "Service",
                config: { token: "t", url: upstream.origin },
                broker: {
                    routes: [{ upstream: "${url}", headers: { authorization: "Bearer ${token}" } }],
                    rules: [
                        { methods: ["DELETE"], paths: ["/repos/*/*"], action: "ask", why: "deletes a repository" },
                        { methods: ["PUT"], action: "deny", why: "never" },
                    ],
                },
            };
            const { deps, asked } = harness(card);
            const gateway = createGateway(deps);
            const base = await addressFor(0, `${upstream.origin}/`);
            const denied = await gateway(new Request(`${base}/anything`, { method: "PUT", body: "x" }));
            expect(denied.status).toBe(403);
            expect(((await denied.json()) as { message: string }).message).toContain("never");
            const held = await gateway(new Request(`${base}/repos/acme/site`, { method: "DELETE" }));
            expect(held.status).toBe(403);
            expect(asked.map((ask) => `${ask.method} ${ask.why ?? ""}`)).toEqual(["DELETE deletes a repository"]);
            expect(upstream.seen).toEqual([]);
        } finally {
            await upstream.close();
        }
    });

    test("an owner's rules replace the connector's, and a pass a person gave lets the rule through", async () => {
        const upstream = await upstreamServer();
        try {
            const card: GatewayCard = {
                name: "Service",
                config: { token: "t", url: upstream.origin },
                broker: { routes: [{ upstream: "${url}" }], rules: [{ action: "deny" }] },
            };
            const owner: BrokerRule[] = [{ methods: ["DELETE"], action: "ask" }];
            const { deps } = harness(card, {
                ownerRules: async () => owner,
                prompts: { canPark: () => true, passed: () => true, ask: async () => ({ allow: false, reason: "unreached" }) },
            });
            const gateway = createGateway(deps);
            const base = await addressFor(0, `${upstream.origin}/`);
            expect((await gateway(new Request(`${base}/x`))).status).toBe(200);
            expect((await gateway(new Request(`${base}/x`, { method: "DELETE" }))).status).toBe(200);
        } finally {
            await upstream.close();
        }
    });

    test("refuses when the owner's host guard leaves the upstream off, or a named approver declines", async () => {
        const card: GatewayCard = {
            name: "Service",
            config: { token: "t", url: "https://api.example.com" },
            broker: { routes: [{ upstream: "${url}" }] },
        };
        const base = await addressFor(0, "https://api.example.com/");
        const narrowed = harness(card, {
            hostGuards: async () => [{ subject: "service", kind: "capability", guard: true, hosts: ["other.example.com"], source: "owner" }],
        });
        expect((await createGateway(narrowed.deps)(new Request(`${base}/x`))).status).toBe(403);
        const gated = harness(card, { credentialGate: { check: async () => ({ allow: false, reason: "only ⟦EMAIL_157⟧ can release it" }) } });
        const refusal = await createGateway(gated.deps)(new Request(`${base}/x`));
        expect(refusal.status).toBe(403);
        expect(((await refusal.json()) as { message: string }).message).toBe("only ⟦EMAIL_157⟧ can release it");
    });

    test("points a redirect back onto the service at the gateway, and leaves one elsewhere alone", async () => {
        const upstream = await upstreamServer((seen) =>
            seen.url === "/a"
                ? { status: 301, headers: { location: "/b?x=1" } }
                : { status: 302, headers: { location: "https://downloads.example.com/f" } },
        );
        try {
            const card: GatewayCard = { name: "Service", config: { token: "t", url: upstream.origin }, broker: { routes: [{ upstream: "${url}" }] } };
            const gateway = createGateway(harness(card).deps);
            const base = await addressFor(0, `${upstream.origin}/`);
            expect((await gateway(new Request(`${base}/a`, { redirect: "manual" }))).headers.get("location")).toBe(`${base}/b?x=1`);
            expect((await gateway(new Request(`${base}/c`, { redirect: "manual" }))).headers.get("location")).toBe("https://downloads.example.com/f");
            expect(upstream.seen.map((entry) => entry.url)).toEqual(["/a", "/c"]);
        } finally {
            await upstream.close();
        }
    });

    test("sets a form-borne credential over whatever the agent sent, and refuses a body that is no form", async () => {
        const upstream = await upstreamServer();
        try {
            const card: GatewayCard = {
                name: "Login",
                config: { token: "client-secret", url: upstream.origin },
                broker: { routes: [{ upstream: "${url}", form: { client_secret: "${token}" } }] },
            };
            const gateway = createGateway(harness(card).deps);
            const base = await addressFor(0, `${upstream.origin}/`);
            const exchanged = await gateway(
                new Request(`${base}/tenant/oauth2/v2.0/token`, {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body: `grant_type=client_credentials&client_secret=${GATEWAY_PLACEHOLDER}`,
                }),
            );
            expect(exchanged.status).toBe(200);
            expect(new URLSearchParams(upstream.seen[0]?.body).get("client_secret")).toBe("client-secret");
            expect(new URLSearchParams(upstream.seen[0]?.body).get("grant_type")).toBe("client_credentials");
            const json = await gateway(new Request(`${base}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
            expect(json.status).toBe(400);
            expect(upstream.seen).toHaveLength(1);
        } finally {
            await upstream.close();
        }
    });
});
