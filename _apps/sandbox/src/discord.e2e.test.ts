import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sandboxContract } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daemonUrl, dockerBuild, dockerRmi, dockerRun, startSandboxContainer, until } from "./e2e-harness.js";
import { environmentHash, hasValidBase } from "./environment/environment.js";

// The Tier-3 real Discord + Whisper e2e: the daemon's gateway client on a REAL bot token receives a REAL
// message (sent by a second, harness-owned bot — the listener deliberately dispatches third-party bot posts,
// see discord/listener-source.ts) and the matched automation's wake lands in the approvals queue — the whole
// trigger path proven without spending an agent turn. Whisper is proven by building the discord capability's
// composed overlay (whisper.cpp from source) and running the real whisper-cli + tiny.en model on the canonical
// whisper.cpp speech sample, pinned to the same tag the fragment builds.
//
// Required env (skipped without them, on top of INTENTIC_E2E):
//   DISCORD_E2E_BOT_TOKEN    — the daemon's capability bot. Must be in the test server with the MESSAGE
//                              CONTENT intent enabled (Developer Portal → Bot → Privileged Gateway Intents).
//   DISCORD_E2E_SENDER_TOKEN — the harness bot that posts the trigger message. Same server + channel.
//   DISCORD_E2E_CHANNEL_ID   — a text channel both bots can read/write.
// Optional: ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN unlock the one real agent-turn spec.
// Manual checklist (not automated): a live voice-channel session (join_voice with real speakers) — the capture
// path is covered by discord/voice.test.ts with an injected exec; the binary + model are covered here.
const BOT_TOKEN = process.env["DISCORD_E2E_BOT_TOKEN"] ?? "";
const SENDER_TOKEN = process.env["DISCORD_E2E_SENDER_TOKEN"] ?? "";
const CHANNEL_ID = process.env["DISCORD_E2E_CHANNEL_ID"] ?? "";
const CLAUDE_CREDS = {
    ...(process.env["ANTHROPIC_API_KEY"] !== undefined && process.env["ANTHROPIC_API_KEY"] !== ""
        ? { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] }
        : {}),
    ...(process.env["CLAUDE_CODE_OAUTH_TOKEN"] !== undefined && process.env["CLAUDE_CODE_OAUTH_TOKEN"] !== ""
        ? { CLAUDE_CODE_OAUTH_TOKEN: process.env["CLAUDE_CODE_OAUTH_TOKEN"] }
        : {}),
};
const enabled =
    (process.env["INTENTIC_E2E"] === "1" || process.env["INTENTIC_E2E"] === "true") && BOT_TOKEN !== "" && SENDER_TOKEN !== "" && CHANNEL_ID !== "";

// The whisper model + speech fixture, cached across runs (the model is ~75 MB; the fixture is whisper.cpp's own
// smoke sample — public-domain JFK speech — fetched from the same v1.9.1 tag the overlay fragment builds).
const CACHE_DIR = join(homedir(), ".cache", "intentic-e2e", "whisper");
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";
const SAMPLE_URL = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.1/samples/jfk.wav";

const ensureCached = async (url: string, file: string): Promise<string> => {
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
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`fetching ${url} failed: ${response.status}`);
    }
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    return path;
};

// Post a message to the test channel as the harness bot — Discord's plain REST, the same API the daemon's
// skill teaches the agent to call.
const sendAsHarnessBot = async (content: string): Promise<void> => {
    const response = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${SENDER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ content }),
    });
    if (!response.ok) {
        throw new Error(`discord send failed ${response.status}: ${await response.text()}`);
    }
};

describe.skipIf(!enabled)("discord + whisper end-to-end (real gateway, real binary)", () => {
    let container: StartedTestContainer;
    let base: string;
    let client: ContractRouterClient<typeof sandboxContract>;
    const overlayTag = `intentic-e2e-whisper:${randomBytes(4).toString("hex")}`;
    let overlayBuilt = false;

    beforeAll(async () => {
        container = await startSandboxContainer(CLAUDE_CREDS);
        base = daemonUrl(container);
        client = createORPCClient(new OpenAPILink(sandboxContract, { url: base }));
        // The discord capability: the gateway bot token + the voice knobs; its fragment composes whisper.cpp
        // into the environment overlay.
        for await (const line of await client.capabilities.add({
            id: "discord",
            kind: "cli",
            config: { provider: "discord", botToken: BOT_TOKEN, voiceModel: "tiny", voiceLanguage: "en" },
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
        await client.automations.upsert({
            id: "e2e-discord",
            trigger: { kind: "listener", provider: "discord", channelId: CHANNEL_ID },
            prompt: "noop",
            requireApproval: true,
            enabled: true,
        });

        // The listener reconciler attaches the gateway within its 30s interval; keep posting a nonce until a
        // held wake carrying it appears (each post is a new message, so the recent-id dedup never bites).
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

        // Drain every approval this spec queued (repeated probes may hold several), then remove the automation.
        const { approvals } = await client.automations.pendingList();
        for (const held of approvals.filter((entry) => entry.automationId === "e2e-discord")) {
            await client.automations.reject({ id: held.id });
        }
        await client.automations.remove({ id: "e2e-discord" });
    }, 240_000);

    it("the composed whisper overlay builds and its whisper-cli transcribes real speech with the tiny.en model", async () => {
        const environment = (await (await fetch(`${base}/environment`)).json()) as { approved?: { content: string; hash: string } };
        expect(environment.approved).toBeDefined();
        const approved = environment.approved as { content: string; hash: string };
        expect(hasValidBase(approved.content)).toBe(true);
        expect(approved.content).toContain("whisper-cli");
        expect(approved.hash).toBe(environmentHash(approved.content));

        // The outside-executor role: build the overlay (compiles whisper.cpp v1.9.1 from source — docker layer
        // cache makes reruns cheap) and run the REAL binary on real speech, with the exact flags voice.ts uses.
        overlayBuilt = true;
        await dockerBuild(approved.content, overlayTag);
        const model = await ensureCached(MODEL_URL, "ggml-tiny.en.bin");
        const sample = await ensureCached(SAMPLE_URL, "jfk.wav");
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
            await client.automations.upsert({
                id: "e2e-agent",
                trigger: { kind: "listener", provider: "discord", channelId: CHANNEL_ID },
                prompt: "This is an automated end-to-end check. Do not use any tools. Reply with the single word: done.",
                model: "haiku",
                enabled: true,
            });
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
