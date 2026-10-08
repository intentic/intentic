import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sandboxContract } from "@intentic/sandbox-contract";
import { e2eTier } from "@intentic/testing/e2e";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { StartedTestContainer } from "testcontainers";
import { daemonUrl, startSandboxContainer, until } from "../harness/e2e-harness.js";
import { automationConfig } from "../harness/route-stores.testing.js";

// Tier-3 real Discord + voice e2e: a real message from a harness bot reaches the gateway and its automation's wake
// queues for approval; voice transcription is proven by the sandbox's own speech engine hearing real speech through
// the door the gateway's voice session uses.
// DISCORD_E2E_BOT_TOKEN: the daemon's capability bot, in the test server with MESSAGE CONTENT intent enabled.
// DISCORD_E2E_SENDER_TOKEN: the harness bot posting the trigger; same server and channel.
// DISCORD_E2E_CHANNEL_ID: a text channel both bots can read and write.
// Voice-channel capture is manual (discord-voice join); this suite covers the engine and model only.
const tier = e2eTier("discord + voice end-to-end (real gateway, real speech engine)", {
    enabledBy: "INTENTIC_E2E",
    secrets: ["DISCORD_E2E_BOT_TOKEN", "DISCORD_E2E_SENDER_TOKEN", "DISCORD_E2E_CHANNEL_ID"],
});
// Claude credentials are an unlock, not a requirement; without them the agent-turn spec alone stands down.
const CLAUDE_CREDS = {
    ...(process.env["ANTHROPIC_API_KEY"] !== undefined && process.env["ANTHROPIC_API_KEY"] !== ""
        ? { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] }
        : {}),
    ...(process.env["CLAUDE_CODE_OAUTH_TOKEN"] !== undefined && process.env["CLAUDE_CODE_OAUTH_TOKEN"] !== ""
        ? { CLAUDE_CODE_OAUTH_TOKEN: process.env["CLAUDE_CODE_OAUTH_TOKEN"] }
        : {}),
};

// A sample of real speech, cached across runs.
const CACHE_DIR = join(homedir(), ".cache", "intentic-e2e", "speech");
const SAMPLE_URL = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.4/samples/jfk.wav";

const ensureCached = async (file: string, fetchBlob: () => Promise<Blob>): Promise<string> => {
    const path = join(CACHE_DIR, file);
    if (
        await stat(path).then(
            () => true,
            () => false,
        )
    ) {
        return path;
    }
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path, Buffer.from(await (await fetchBlob()).arrayBuffer()));
    return path;
};

// Posts as the harness bot via Discord's plain REST, the same API the daemon's skill teaches the agent to call.
const sendAsHarnessBot = async (content: string): Promise<void> => {
    const response = await fetch(`https://discord.com/api/v10/channels/${tier.secrets.DISCORD_E2E_CHANNEL_ID}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${tier.secrets.DISCORD_E2E_SENDER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ content }),
    });
    if (!response.ok) {
        throw new Error(`discord send failed ${response.status}: ${await response.text()}`);
    }
};

describe.skipIf(!tier.runs)(tier.title, () => {
    let container: StartedTestContainer;
    let base: string;
    let client: ContractRouterClient<typeof sandboxContract>;

    beforeAll(async () => {
        container = await startSandboxContainer(CLAUDE_CREDS);
        base = daemonUrl(container);
        client = createORPCClient(new OpenAPILink(sandboxContract, { url: base }));
        // The discord capability: gateway bot token plus its voice language.
        for await (const line of await client.capabilities.add({
            id: "discord",
            kind: "cli",
            config: { provider: "discord", botToken: tier.secrets.DISCORD_E2E_BOT_TOKEN, voiceLanguage: "en" },
        })) {
            void line;
        }
    }, 1_200_000);

    afterAll(async () => {
        await client?.automations.remove({ id: "e2e-discord" }).catch(() => {});
        await client?.automations.remove({ id: "e2e-agent" }).catch(() => {});
        await client?.capabilities.remove({ id: "discord" }).catch(() => {});
        await container?.stop().catch(() => {});
    }, 120_000);

    it("a real channel message reaches the listener automation and is held for approval", async () => {
        await client.automations.upsert(
            automationConfig("e2e-discord", {
                trigger: { kind: "listener", provider: "discord", channelId: tier.secrets.DISCORD_E2E_CHANNEL_ID },
                prompt: "noop",
                requireApproval: true,
            }),
        );

        // Reconciler attaches the gateway within 30s; keep posting a nonce since each post is new and dedup won't bite.
        const nonce = `intentic-e2e-${randomBytes(6).toString("hex")}`;
        let lastSent = 0;
        const approval = await until(
            async () => {
                if (Date.now() - lastSent > 15_000) {
                    lastSent = Date.now();
                    await sendAsHarnessBot(`${nonce} — automated intentic e2e probe, ignore`);
                }
                const { approvals } = await client.automations.pendingList();
                return approvals.find((held) => held.automationId === "e2e-discord" && held.payload?.includes(nonce) === true);
            },
            "the gateway-dispatched approval",
            180_000,
        );
        expect(approval.payload).toContain(nonce);

        // Drains every approval this spec queued (repeated probes may hold several) before removing the automation.
        const { approvals } = await client.automations.pendingList();
        for (const held of approvals.filter((entry) => entry.automationId === "e2e-discord")) {
            await client.automations.reject({ id: held.id });
        }
        await client.automations.remove({ id: "e2e-discord" });
    }, 240_000);

    it("the sandbox's own speech engine hears real speech through the door the voice session uses", async () => {
        const sample = await ensureCached("jfk.wav", async () => {
            const response = await fetch(SAMPLE_URL);
            if (!response.ok) {
                throw new Error(`fetching ${SAMPLE_URL} failed: ${response.status}`);
            }
            return response.blob();
        });
        // wait=1, as the gateway asks: an image that does not bake the model fetches it first rather than refusing.
        const response = await fetch(`${base}/speech/transcribe?lang=en&wait=1`, {
            method: "POST",
            headers: { "content-type": "audio/wav" },
            body: await readFile(sample),
        });
        expect(response.status).toBe(200);
        const { text } = (await response.json()) as { text: string };
        expect(text.toLowerCase()).toContain("fellow americans");
    }, 1_800_000);

    it.skipIf(Object.keys(CLAUDE_CREDS).length === 0)(
        "a real message wakes a real agent turn to completion (no approval hold)",
        async () => {
            await client.automations.upsert(
                automationConfig("e2e-agent", {
                    trigger: { kind: "listener", provider: "discord", channelId: tier.secrets.DISCORD_E2E_CHANNEL_ID },
                    prompt: "This is an automated end-to-end check. Do not use any tools. Reply with the single word: done.",
                }),
            );
            const nonce = `intentic-e2e-agent-${randomBytes(6).toString("hex")}`;
            let lastSent = 0;
            const run = await until(
                async () => {
                    if (Date.now() - lastSent > 20_000) {
                        lastSent = Date.now();
                        await sendAsHarnessBot(`${nonce} — automated intentic e2e agent probe`);
                    }
                    const { automations } = await client.automations.list();
                    return automations.find((automation) => automation.id === "e2e-agent")?.runs[0];
                },
                "the completed agent run",
                240_000,
            );
            expect(run.outcome).toBe("completed");
            await client.automations.remove({ id: "e2e-agent" });
        },
        300_000,
    );
});
