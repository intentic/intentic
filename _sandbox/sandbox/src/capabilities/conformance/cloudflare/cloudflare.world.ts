import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Capability, CliConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { RuleAsk } from "../../broker/broker-gateway.js";
import { nodeRequest } from "../../../system/tls/node-request.js";
import { cardHost, installSkill, loadCard, skillCodeBlock } from "../kit/card.js";
import { cleanupStack, type CleanupStack } from "../kit/cleanup.js";
import { runCommand, shellQuote, successful } from "../kit/command.js";
import { redirectedFetch, redirectedNodeRequest, startGateway } from "../kit/gateway.js";
import { responseJson, type WorldKind } from "../kit/scenario.js";
import { cloudflareResponses, startCloudflareFake } from "./cloudflare.fake.js";

const identifier = z.string().regex(/^[a-f0-9]{32}$/u);
const zoneName = z.string().regex(/^[a-z0-9.-]+$/u);

const upstream = async (kind: WorldKind, cleanup: CleanupStack) => {
    if (kind === "live") {
        return { fake: undefined, transport: fetch, probeRequest: nodeRequest };
    }
    const fake = await startCloudflareFake();
    cleanup.add(fake.close);
    const origins = { "https://api.cloudflare.com": fake.origin };
    return { fake, transport: redirectedFetch(origins), probeRequest: redirectedNodeRequest(origins) };
};

type Agent = (command: string) => ReturnType<typeof runCommand>;

// Names are registered before POST so cleanup can find a record even if the create response was lost.
const scratchRecords = (agent: Agent, cleanup: CleanupStack) => {
    const records = new Map<string, string>();
    const deleteRecords = async (name: string): Promise<void> => {
        const zone = records.get(name);
        if (zone === undefined) {
            return;
        }
        const listed = responseJson(
            cloudflareResponses.recordList,
            await successful(agent(`cf GET ${shellQuote(`zones/${zone}/dns_records?type=TXT&name=${name}`)}`)),
        );
        for (const record of listed.result) {
            expect(record.name).toBe(name);
            expect(record.type).toBe("TXT");
            responseJson(cloudflareResponses.deleted, await successful(agent(`cf DELETE zones/${zone}/dns_records/${identifier.parse(record.id)}`)));
        }
        records.delete(name);
    };
    cleanup.add(async () => {
        const results = await Promise.allSettled([...records.keys()].map(deleteRecords));
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length > 0) {
            throw new AggregateError(
                failures.map((failure) => failure.reason),
                "scratch DNS cleanup failed",
            );
        }
    });
    return { records, deleteRecords };
};

export const cloudflareWorld = async (kind: WorldKind) => {
    const root = await mkdtemp(join(tmpdir(), "cloudflare-conformance-"));
    const cleanup = cleanupStack("Cloudflare world");
    cleanup.add(async () => rm(root, { recursive: true, force: true }));
    try {
        const { fake, transport, probeRequest } = await upstream(kind, cleanup);
        const token = fake?.token ?? z.string().min(1).parse(process.env["CLOUDFLARE_E2E_TOKEN"]);
        const accountId = fake?.accountId ?? (process.env["CLOUDFLARE_E2E_ACCOUNT_ID"] || undefined);
        const scratch = fake?.zone.name ?? (process.env["CLOUDFLARE_E2E_ZONE"] || undefined);
        if (accountId !== undefined) {
            identifier.parse(accountId);
        }
        if (scratch !== undefined) {
            zoneName.parse(scratch);
        }
        const config: CliConfig = { provider: "cloudflare", token };
        if (accountId !== undefined) {
            config["accountId"] = accountId;
        }
        const card: Capability = { id: "cloudflare", kind: "cli", config };
        const host = cardHost(root, card);
        const { registry, contribution } = await loadCard(host, config.provider);
        const home = join(root, "agent-home");
        await mkdir(home);
        const asks: RuleAsk[] = [];
        const gateway = await startGateway({
            host,
            card,
            spec: contribution.spec,
            fetch: transport,
            ask: async (input) => {
                asks.push(input);
                return { allow: false, reason: "conformance owner denied Cloudflare deletion" };
            },
        });
        cleanup.add(gateway.close);
        const skill = await installSkill(host, card);
        const helper = skillCodeBlock(skill, "sh");
        const agent: Agent = (command) => runCommand(`${helper}\n${command}`, { home, env: gateway.env });
        return {
            kind,
            root,
            home,
            config,
            card,
            host,
            registry,
            spec: contribution.spec,
            skill,
            helper,
            token,
            accountId,
            scratch,
            fake,
            asks,
            gateway,
            transport,
            probeRequest,
            agent,
            ...scratchRecords(agent, cleanup),
            close: cleanup.close,
        };
    } catch (error) {
        await cleanup.close().catch(() => {
            // allow(silent-catch): report the setup error rather than masking it with cleanup errors.
        });
        throw error;
    }
};

export type CloudflareWorld = Awaited<ReturnType<typeof cloudflareWorld>>;
