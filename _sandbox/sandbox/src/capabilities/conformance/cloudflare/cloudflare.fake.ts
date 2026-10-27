import type { ServerResponse } from "node:http";
import { readBody, sendJson } from "@intentic/testing/http-fake";
import { z } from "zod";
import { httpServer } from "../kit/http.js";

const error = z.object({ code: z.number(), message: z.string().min(1) });
const envelope = z.object({ errors: z.array(error), messages: z.array(z.unknown()) });
const listInfo = z.object({ page: z.number(), per_page: z.number(), count: z.number(), total_count: z.number() });
const account = z.object({ id: z.string().min(1), name: z.string() });
const zone = z.object({ id: z.string().min(1), name: z.string(), status: z.string(), paused: z.boolean() });
const record = z.object({ id: z.string().min(1), type: z.string(), name: z.string(), content: z.string(), proxied: z.boolean(), ttl: z.number() });
const worker = z.object({ id: z.string(), modified_on: z.string() });
const project = z.object({ name: z.string(), subdomain: z.string(), domains: z.array(z.string()) });

export const cloudflareItems = { account, zone, record, worker, project };

const answer = <T extends z.ZodType>(result: T) => envelope.extend({ success: z.literal(true), result });
const list = <T extends z.ZodType>(item: T) => answer(z.array(item).min(1)).extend({ result_info: listInfo.optional() });

// Lists require a row so live cannot verify an item contract with an empty response.
export const cloudflareResponses = {
    token: answer(z.object({ status: z.string().min(1) })),
    accounts: list(account),
    zones: list(zone),
    records: list(record),
    workers: list(worker),
    projects: list(project),
    record: answer(record),
    deleted: answer(z.object({ id: z.string().min(1) })),
    recordList: answer(z.array(record)).extend({ result_info: listInfo }),
    refused: envelope.extend({ success: z.literal(false), errors: z.array(error).min(1), result: z.null() }),
};

const ok = <T>(result: T) => ({ success: true as const, errors: [], messages: [], result });
const page = <T>(result: T[]) => ({ ...ok(result), result_info: { page: 1, per_page: 100, count: result.length, total_count: result.length } });

export const cloudflareSamples = {
    token: cloudflareResponses.token.parse(ok({ status: "active" })),
    accounts: cloudflareResponses.accounts.parse(page([{ id: "a".repeat(32), name: "Conformance account" }])),
    zones: cloudflareResponses.zones.parse(page([{ id: "b".repeat(32), name: "conformance.invalid", status: "active", paused: false }])),
    records: cloudflareResponses.records.parse(
        page([{ id: "c".repeat(32), type: "TXT", name: "fixture.conformance.invalid", content: "fixture", proxied: false, ttl: 1 }]),
    ),
    workers: cloudflareResponses.workers.parse(ok([{ id: "conformance-worker", modified_on: "2026-01-01T00:00:00.000Z" }])),
    projects: cloudflareResponses.projects.parse(
        page([{ name: "conformance-pages", subdomain: "conformance-pages.pages.dev", domains: ["conformance-pages.pages.dev"] }]),
    ),
};

const refused = (response: ServerResponse, status: number, code: number, message: string): void =>
    sendJson(response, status, cloudflareResponses.refused.parse({ success: false, errors: [{ code, message }], messages: [], result: null }));

type DnsRecord = z.infer<typeof record>;

const dns = (response: ServerResponse, method: string, url: URL, body: string, records: Map<string, DnsRecord>): void => {
    const id = url.pathname.split("/")[6];
    if (method === "GET" && id === undefined) {
        const name = url.searchParams.get("name");
        sendJson(
            response,
            200,
            cloudflareResponses.recordList.parse(page([...records.values()].filter((entry) => name === null || entry.name === name))),
        );
    } else if (method === "POST" && id === undefined) {
        const input = record.omit({ id: true }).parse(JSON.parse(body));
        const created = record.parse({ ...input, id: (records.size + 1).toString(16).padStart(32, "0") });
        records.set(created.id, created);
        sendJson(response, 200, cloudflareResponses.record.parse(ok(created)));
    } else if (id !== undefined && records.has(id) && method === "PATCH") {
        const input = z.object({ content: z.string() }).parse(JSON.parse(body));
        const updated = record.parse({ ...records.get(id), ...input });
        records.set(id, updated);
        sendJson(response, 200, cloudflareResponses.record.parse(ok(updated)));
    } else if (method === "DELETE" && id !== undefined && records.delete(id)) {
        sendJson(response, 200, cloudflareResponses.deleted.parse(ok({ id })));
    } else {
        refused(response, 404, 81044, "Record does not exist.");
    }
};

const reads = (path: string, accountId: string) => {
    const samples = cloudflareSamples;
    return new Map<string, unknown>([
        ["/client/v4/user/tokens/verify", samples.token],
        [`/client/v4/accounts/${accountId}/tokens/verify`, samples.token],
        ["/client/v4/accounts", samples.accounts],
        ["/client/v4/zones", samples.zones],
        [`/client/v4/accounts/${accountId}/workers/scripts`, samples.workers],
        [`/client/v4/accounts/${accountId}/pages/projects`, samples.projects],
    ]).get(path);
};

export const startCloudflareFake = async () => {
    const token = "cloudflare-conformance-user-token";
    const accountToken = "cloudflare-conformance-account-token";
    const accountId = cloudflareSamples.accounts.result[0]!.id;
    const sampleZone = cloudflareSamples.zones.result[0]!;
    const requests: { method: string; path: string; authorization: string; headers: string; body: string }[] = [];
    const records = new Map(cloudflareSamples.records.result.map((entry) => [entry.id, { ...entry }]));
    const server = await httpServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const method = request.method ?? "GET";
        const authorization = request.headers.authorization ?? "";
        const body = await readBody(request);
        requests.push({ method, path: url.pathname + url.search, authorization, headers: JSON.stringify(request.headers), body });
        const accountOwned = authorization === `Bearer ${accountToken}`;
        if (authorization !== `Bearer ${token}` && !accountOwned) {
            refused(response, 401, 1000, "Invalid API Token");
        } else if (accountOwned && url.pathname === "/client/v4/user/tokens/verify") {
            // Account verification has its own documented endpoint; this refusal still needs an account-token observation.
            refused(response, 401, 1000, "Invalid API Token");
        } else if (!accountOwned && url.pathname === `/client/v4/accounts/${accountId}/tokens/verify`) {
            refused(response, 401, 1000, "Invalid API Token");
        } else if (url.pathname.startsWith(`/client/v4/zones/${sampleZone.id}/dns_records`)) {
            dns(response, method, url, body, records);
        } else if (method === "GET" && reads(url.pathname, accountId) !== undefined) {
            sendJson(response, 200, reads(url.pathname, accountId));
        } else if (method === "GET" && url.pathname.endsWith("/dns_records")) {
            refused(response, 403, 10000, "Authentication error");
        } else {
            throw new Error(`Cloudflare fake has no endpoint for ${method} ${url.pathname}`);
        }
    });
    return { ...server, token, accountToken, accountId, zone: sampleZone, requests };
};
