import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { type DiscordCliConfig, joinVoice, leaveVoice, voiceStatus } from "./voice.js";

// The agent-facing surface of the voice session manager: an in-process SDK MCP server (the uiServer pattern),
// injected per turn once per discord capability. Server name is the instance id, so with two bots the model
// sees mcp__<id>__join_voice per instance; each is bound to that instance's config (bot token, voice knobs).
export const createDiscordVoiceServer = (services: Services, wake: WakeFn, id: string, config: DiscordCliConfig): McpSdkServerConfigWithInstance =>
    createSdkMcpServer({
        name: id,
        tools: [
            tool(
                "join_voice",
                "Join a Discord voice channel and transcribe the conversation (per-speaker, local whisper). The transcript in .intentic/transcripts/ updates live after every utterance — read it mid-call — and each utterance fires a voice_utterance listener event. When the call ends — everyone leaves or leave_voice is called — a voice_transcript event fires with the finalized transcript so it can be turned into notes or tasks.",
                { channelId: z.string().describe("The voice channel id (list channels via the discord skill to find it)") },
                async ({ channelId }) => ({ content: [{ type: "text", text: await joinVoice(services, channelId, wake, config) }] }),
            ),
            tool("leave_voice", "Leave the current Discord voice channel now and finalize the transcript.", {}, async () => ({
                content: [{ type: "text", text: await leaveVoice() }],
            })),
            tool("voice_status", "Report the current Discord voice session: channel, duration, participants, utterances transcribed.", {}, () =>
                Promise.resolve({ content: [{ type: "text" as const, text: voiceStatus() }] }),
            ),
        ],
    });
