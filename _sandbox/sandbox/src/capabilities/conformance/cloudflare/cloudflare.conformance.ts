import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { probeCapability } from "../../probe.js";
import { GATEWAY_PLACEHOLDER } from "../../broker/broker-routes.js";
import { skillCommand } from "../kit/card.js";
import { runCommand, shellQuote, successful } from "../kit/command.js";
import { startGateway } from "../kit/gateway.js";
import { responseJson, type Scenario } from "../kit/scenario.js";
import { cloudflareItems, cloudflareResponses, cloudflareSamples } from "./cloudflare.fake.js";
import type { CloudflareWorld } from "./cloudflare.world.js";

const upstreamAuth = (world: CloudflareWorld, from: number): void => {
    if (world.fake === undefined) {
        return;
    }
    const requests = world.fake.requests.slice(from);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
        expect(request.authorization).toBe(`Bearer ${world.token}`);
        expect(request.headers).not.toContain(GATEWAY_PLACEHOLDER);
        const headers = responseJson(z.record(z.string(), z.unknown()), request.headers);
        delete headers["authorization"];
        expect(JSON.stringify([headers, request.path, request.body]).includes(world.token)).toBe(false);
    }
};

const agentBoundary = (world: CloudflareWorld, output: string): void => {
    expect(world.gateway.env["CLOUDFLARE_API_TOKEN_CLOUDFLARE"]).toBe(GATEWAY_PLACEHOLDER);
    expect(JSON.stringify(world.gateway.env).includes(world.token)).toBe(false);
    expect(world.skill.includes(world.token)).toBe(false);
    expect(output.includes(world.token)).toBe(false);
    expect(output.includes(GATEWAY_PLACEHOLDER)).toBe(false);
};

const zoneFor = async (world: CloudflareWorld, scratch = false): Promise<string> => {
    const name = scratch ? z.string().min(1).parse(world.scratch) : undefined;
    const query = name === undefined ? "per_page=50" : `name=${name}`;
    const zones = responseJson(cloudflareResponses.zones, await successful(world.agent(`cf GET ${shellQuote(`zones?${query}`)}`)));
    if (name !== undefined) {
        expect(zones.result.map((entry) => entry.name)).toEqual([name]);
        const command = skillCommand(world.skill, "A zone id by name").replace("example.com", name);
        expect((await successful(world.agent(command))).trim()).toBe(zones.result[0]!.id);
    }
    return z
        .string()
        .regex(/^[a-f0-9]{32}$/u)
        .parse(zones.result[0]!.id);
};

const skillScenario = <T, O>(options: {
    readonly label: string;
    readonly schema: z.ZodType<T>;
    readonly output: z.ZodType<O>;
    readonly project: (raw: T) => O;
    readonly sample: T;
    readonly stream?: true;
    readonly account?: true;
    readonly dns?: true;
}): Scenario<CloudflareWorld> => ({
    name: `documented ${options.label} through the gateway`,
    requiredSecrets: options.account === true ? ["CLOUDFLARE_E2E_ACCOUNT_ID"] : [],
    run: async (world) => {
        const from = world.fake?.requests.length ?? 0;
        const placeholders = options.dns === true ? { ZONE_ID: await zoneFor(world) } : {};
        const command = skillCommand(world.skill, options.label, placeholders);
        const file = shellQuote(join(world.home, "response.json"));
        const observed = command.replace(" | jq ", ` | tee ${file} | jq `);
        expect(observed).not.toBe(command);
        const output = await successful(world.agent(observed));
        const raw = responseJson(options.schema, await successful(world.agent(`cat ${file}`)));
        const verbatim = await successful(world.agent(command));
        for (const text of [output, verbatim]) {
            const json = options.stream === true ? await successful(runCommand("jq -sc .", { home: world.home, input: text })) : text;
            const result = responseJson(options.output, json);
            expect(result).toEqual(options.project(raw));
            if (world.fake !== undefined) {
                expect(result).toEqual(options.project(options.sample));
            }
            agentBoundary(world, text);
        }
        upstreamAuth(world, from);
    },
});

const probeScenarios: readonly Scenario<CloudflareWorld>[] = [
    {
        name: "declared probe authenticates and reports result.status",
        run: async (world) => {
            const result = await probeCapability(world.registry, world.card, world.probeRequest);
            const raw = responseJson(cloudflareResponses.token, await successful(world.agent("cf GET user/tokens/verify")));
            expect(raw.result.status).toBe("active");
            expect(result).toEqual({
                checked: true,
                ok: true,
                who: raw.result.status,
                message: `Reached Cloudflare, authenticated as ${raw.result.status}.`,
            });
        },
    },
    {
        name: "bad token returns Cloudflare's error envelope and a readable probe reason",
        run: async (world) => {
            const token = "a".repeat(40);
            const response = await world.transport("https://api.cloudflare.com/client/v4/user/tokens/verify", {
                headers: { authorization: `Bearer ${token}` },
            });
            expect(response.status).toBe(401);
            expect(responseJson(cloudflareResponses.refused, await response.text()).errors).toEqual([{ code: 1000, message: "Invalid API Token" }]);
            expect(await probeCapability(world.registry, { ...world.card, config: { ...world.config, token } }, world.probeRequest)).toEqual({
                checked: true,
                ok: false,
                message: "Cloudflare answered 401: the credential was refused.",
            });
        },
    },
    {
        name: "user and account tokens use their own verify endpoints; account token reads zones",
        fakeOnly: "No dedicated account-owned live credential is configured.",
        run: async (world) => {
            const fake = world.fake!;
            const user = await world.transport(`https://api.cloudflare.com/client/v4/accounts/${fake.accountId}/tokens/verify`, {
                headers: { authorization: `Bearer ${world.token}` },
            });
            expect(user.status).toBe(401);
            expect(responseJson(cloudflareResponses.refused, await user.text()).errors).toEqual([{ code: 1000, message: "Invalid API Token" }]);
            const headers = { authorization: `Bearer ${fake.accountToken}` };
            const verified = await world.transport(`https://api.cloudflare.com/client/v4/accounts/${fake.accountId}/tokens/verify`, { headers });
            expect(verified.status).toBe(200);
            expect(responseJson(cloudflareResponses.token, await verified.text()).result.status).toBe("active");
            const zones = await world.transport("https://api.cloudflare.com/client/v4/zones", { headers });
            expect(responseJson(cloudflareResponses.zones, await zones.text())).toEqual(cloudflareSamples.zones);
        },
    },
    {
        name: "working account-owned token should pass the card probe",
        fakeOnly: "The fake models the suspected user-endpoint refusal; no account token was available to observe it.",
        todo: "Confirm rejection at /user/tokens/verify with an account token; documented verify route is /accounts/{account_id}/tokens/verify.",
        // https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/
        run: async (world) => {
            const fake = world.fake!;
            const card = { ...world.card, config: { ...world.config, token: fake.accountToken, accountId: fake.accountId } };
            expect(await probeCapability(world.registry, card, world.probeRequest)).toEqual({
                checked: true,
                ok: true,
                who: "active",
                message: "Reached Cloudflare, authenticated as active.",
            });
        },
    },
];

const reads: readonly Scenario<CloudflareWorld>[] = [
    skillScenario({
        label: "Token ok?",
        schema: cloudflareResponses.token,
        output: z.string(),
        project: (raw) => raw.result.status,
        sample: cloudflareSamples.token,
    }),
    skillScenario({
        label: "Accounts",
        schema: cloudflareResponses.accounts,
        output: z.array(cloudflareItems.account).min(1),
        project: (raw) => raw.result,
        sample: cloudflareSamples.accounts,
        stream: true,
    }),
    skillScenario({
        label: "Zones (domains)",
        schema: cloudflareResponses.zones,
        output: z.array(cloudflareItems.zone).min(1),
        project: (raw) => raw.result,
        sample: cloudflareSamples.zones,
        stream: true,
    }),
    skillScenario({
        label: "DNS records",
        schema: cloudflareResponses.records,
        output: z.array(cloudflareItems.record).min(1),
        project: (raw) => raw.result,
        sample: cloudflareSamples.records,
        stream: true,
        dns: true,
    }),
    skillScenario({
        label: "Workers scripts",
        schema: cloudflareResponses.workers,
        output: z.array(cloudflareItems.worker).min(1),
        project: (raw) => raw.result,
        sample: cloudflareSamples.workers,
        stream: true,
        account: true,
    }),
    skillScenario({
        label: "Pages projects",
        schema: cloudflareResponses.projects,
        output: z.array(cloudflareItems.project).min(1),
        project: (raw) => raw.result,
        sample: cloudflareSamples.projects,
        stream: true,
        account: true,
    }),
    {
        name: "refused zone read exposes success false and errors code/message",
        run: async (world) => {
            const from = world.fake?.requests.length ?? 0;
            const raw = await successful(world.agent("cf GET zones/00000000000000000000000000000000/dns_records"));
            const response = responseJson(cloudflareResponses.refused, raw);
            const output = await successful(runCommand("jq -c '.errors[] | {code, message}'", { home: world.home, input: raw }));
            expect(
                output
                    .trim()
                    .split("\n")
                    .map((line) => responseJson(z.object({ code: z.number(), message: z.string() }), line)),
            ).toEqual(response.errors);
            agentBoundary(world, raw);
            upstreamAuth(world, from);
        },
    },
    {
        name: "absent accountId reaches the agent as an empty string and Accounts supplies the fallback",
        run: async (world) => {
            const { accountId: omitted, ...config } = world.config;
            void omitted;
            const card = { ...world.card, config };
            const gateway = await startGateway({
                host: { ...world.host, capabilities: { list: async () => [card] } },
                card,
                spec: world.spec,
                fetch: world.transport,
            });
            try {
                expect(Object.hasOwn(gateway.env, "CLOUDFLARE_ACCOUNT_ID_CLOUDFLARE")).toBe(true);
                expect(gateway.env["CLOUDFLARE_ACCOUNT_ID_CLOUDFLARE"]).toBe("");
                const script = `${world.helper}\ntest "\${CLOUDFLARE_ACCOUNT_ID_CLOUDFLARE+x}" = x\ntest -z "$CLOUDFLARE_ACCOUNT_ID_CLOUDFLARE"\n${skillCommand(world.skill, "Accounts")}`;
                const output = await successful(runCommand(script, { home: world.home, env: gateway.env }));
                const accounts = await successful(runCommand("jq -sc .", { home: world.home, input: output }));
                responseJson(z.array(cloudflareItems.account).min(1), accounts);
            } finally {
                await gateway.close();
            }
        },
    },
];

// Change only the example payload; the helper, verb, path and flags remain the installed skill's command.
const recordCommand = (
    world: CloudflareWorld,
    label: string,
    placeholders: Readonly<Record<string, string>>,
    body: Readonly<Record<string, string | boolean | number>>,
): string => {
    const command = skillCommand(world.skill, label, placeholders);
    const filled = command.replace(/ -d '[^']*'/u, ` -d ${shellQuote(JSON.stringify(body))}`);
    expect(filled).not.toBe(command);
    return filled;
};

const writeRecords: Scenario<CloudflareWorld> = {
    name: "documented create, update and delete round-trip a unique TXT record",
    writes: true,
    requiredSecrets: ["CLOUDFLARE_E2E_ZONE"],
    run: async (world) => {
        const from = world.fake?.requests.length ?? 0;
        const zoneId = await zoneFor(world, true);
        const name = `_intentic-conformance-${randomUUID()}.${world.scratch}`;
        world.records.set(name, zoneId);
        try {
            const payload = { type: "TXT", name, content: "intentic-conformance-created", proxied: false, ttl: 1 };
            const created = responseJson(
                cloudflareResponses.record,
                await successful(world.agent(recordCommand(world, "Create a record", { ZONE_ID: zoneId }, payload))),
            );
            const { id: recordId, ...fields } = created.result;
            expect(fields).toEqual(payload);
            const placeholders = {
                ZONE_ID: zoneId,
                RECORD_ID: z
                    .string()
                    .regex(/^[a-f0-9]{32}$/u)
                    .parse(recordId),
            };
            const updated = responseJson(
                cloudflareResponses.record,
                await successful(
                    world.agent(recordCommand(world, "Update / delete a record", placeholders, { content: "intentic-conformance-updated" })),
                ),
            );
            expect(updated.result).toEqual({ ...created.result, content: "intentic-conformance-updated" });
            const deleted = responseJson(
                cloudflareResponses.deleted,
                await successful(world.agent(skillCommand(world.skill, "Update / delete a record", placeholders, 1))),
            );
            expect(deleted.result.id).toBe(created.result.id);
            const gone = responseJson(
                cloudflareResponses.recordList,
                await successful(world.agent(`cf GET ${shellQuote(`zones/${zoneId}/dns_records?type=TXT&name=${name}`)}`)),
            );
            expect(gone.result).toEqual([]);
            world.records.delete(name);
            upstreamAuth(world, from);
        } finally {
            await world.deleteRecords(name);
        }
    },
};

const brokerRules: Scenario<CloudflareWorld> = {
    name: "zone, Worker and Pages DELETE ask and deny before upstream; DNS DELETE is forwarded",
    fakeOnly: "A broken rule could delete a real zone, Worker or Pages project.",
    run: async (world) => {
        const fake = world.fake!;
        const from = fake.requests.length;
        const paths = [
            `zones/${fake.zone.id}`,
            `accounts/${fake.accountId}/workers/scripts/conformance-worker`,
            `accounts/${fake.accountId}/pages/projects/conformance-pages`,
        ];
        const before = world.asks.length;
        for (const path of paths) {
            const output = await successful(world.agent(`cf DELETE ${shellQuote(path)}`));
            expect(responseJson(z.object({ gateway: z.literal("intentic"), message: z.string() }), output).message).toBe(
                "conformance owner denied Cloudflare deletion",
            );
            expect(fake.requests.length).toBe(from);
        }
        expect(world.asks.slice(before).map((ask) => ({ method: ask.method, target: ask.target, why: ask.why }))).toEqual(
            paths.map((path) => ({
                method: "DELETE",
                target: `api.cloudflare.com/client/v4/${path}`,
                why: "deletes a whole zone, Worker or Pages project",
            })),
        );
        const record = cloudflareSamples.records.result[0]!;
        const path = `zones/${fake.zone.id}/dns_records/${record.id}`;
        const deleted = responseJson(cloudflareResponses.deleted, await successful(world.agent(`cf DELETE ${path}`)));
        expect(deleted.result.id).toBe(record.id);
        expect(world.asks.length).toBe(before + paths.length);
        expect(fake.requests.slice(from).map((request) => ({ method: request.method, path: request.path }))).toEqual([
            { method: "DELETE", path: `/client/v4/${path}` },
        ]);
        upstreamAuth(world, from);
    },
};

export const conformance: readonly Scenario<CloudflareWorld>[] = [...probeScenarios, ...reads, writeRecords, brokerRules];
