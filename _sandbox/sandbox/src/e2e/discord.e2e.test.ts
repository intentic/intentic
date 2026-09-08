import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { downloadFile } from "@huggingface/hub";
import { hasOfficialBase, sandboxContract } from "@intentic/sandbox-contract";
import { e2eTier } from "@intentic/testing/e2e";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daemonUrl, dockerBuild, dockerRmi, dockerRun, startSandboxContainer, until } from "../harness/e2e-harness.js";
import { automationConfig } from "../harness/route-stores.testing.js";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";

// Tier-3 real Discord + Whisper e2e: a real message from a harness bot reaches the gateway and its automation's wake
// queues for approval; whisper is proven by building the composed overlay and running whisper-cli on real speech.
// DISCORD_E2E_BOT_TOKEN: the daemon's capability bot, in the test server with MESSAGE CONTENT intent enabled.
// DISCORD_E2E_SENDER_TOKEN: the harness bot posting the trigger; same server and channel.
// DISCORD_E2E_CHANNEL_ID: a text channel both bots can read and write.
// Voice-channel capture is manual (discord-voice join); this suite covers the binary and model only.
const tier = e2eTier("discord + whisper end-to-end (real gateway, real binary)", {
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

// Whisper model (~75MB) and sample audio, cached across runs from the same v1.9.1 tag the overlay builds.
const CACHE_DIR = join(homedir(), ".cache", "intentic-e2e", "whisper");
const SAMPLE_URL = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.1/samples/jfk.wav";

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
    const overlayTag = `intentic-e2e-whisper:${randomBytes(4).toString("hex")}`;
    let overlayBuilt = false;

    beforeAll(async () => {
        container = await startSandboxContainer(CLAUDE_CREDS);
        base = daemonUrl(container);
        client = createORPCClient(new OpenAPILink(sandboxContract, { url: base }));
        // The discord capability: gateway bot token plus voice knobs; its fragment composes whisper.cpp in.
        for await (const line of await client.capabilities.add({
            id: "discord",
            kind: "cli",
            config: { provider: "discord", botToken: tier.secrets.DISCORD_E2E_BOT_TOKEN, voiceModel: "tiny", voiceLanguage: "en" },
        })) {
            void line;
        }
    }, 1_200_000);

    afterAll(async () => {
        await client?.automations.remove({ id: "e2e-discord" }).catch(() => {});
        await client?.automations.remove({ id: "e2e-agent" }).catch(() => {});
        await client?.capabilities.remove({ id: "discord" }).catch(() => {});
        await container?.stop().catch(() => {});
        if (overlayBuilt) {
            await dockerRmi(overlayTag);
        }
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

    it("the composed whisper overlay builds and its whisper-cli transcribes real speech with the tiny.en model", async () => {
        const environment = (await (await fetch(`${base}/environment`)).json()) as { approved?: { content: string; hash: string } };
        expect(environment.approved).toEqual(expect.any(Object));
        const approved = environment.approved as { content: string; hash: string };
        expect(hasOfficialBase(approved.content)).toBe(true);
        expect(approved.content).toContain("whisper-cli");
        expect(approved.hash).toBe(sha256Hex(approved.content));

        // Outside-executor role: builds the overlay from source (cached by docker) and runs the real binary on speech.
        overlayBuilt = true;
        await dockerBuild(approved.content, overlayTag);
        // HF's CAS bridge 403s anonymous plain HTTP; downloadFile speaks Xet instead.
        const model = await ensureCached("ggml-tiny.en.bin", async () => {
            const blob = await downloadFile({ repo: "ggerganov/whisper.cpp", path: "ggml-tiny.en.bin" });
            if (blob === null) {
                throw new Error("ggerganov/whisper.cpp has no ggml-tiny.en.bin");
            }
            return blob;
        });
        const sample = await ensureCached("jfk.wav", async () => {
            const response = await fetch(SAMPLE_URL);
            if (!response.ok) {
                throw new Error(`fetching ${SAMPLE_URL} failed: ${response.status}`);
            }
            return response.blob();
        });
        const output = await dockerRun(
            overlayTag,
            [
                { host: model, container: "/fx/ggml-tiny.en.bin" },
                { host: sample, container: "/fx/jfk.wav" },
            ],
            ["whisper-cli", "-m", "/fx/ggml-tiny.en.bin", "-f", "/fx/jfk.wav", "-l", "en", "--no-timestamps", "--no-prints"],
        );
        expect(output.toLowerCase()).toContain("fellow americans");
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
