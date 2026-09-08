import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { errorMessage } from "@intentic/base/errors";
import { STATE_DIR, WHISPER_MODEL_REPO } from "@intentic/sandbox-contract";
import { EndBehaviorType, entersState, joinVoiceChannel, type VoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";
import { downloadFile } from "@huggingface/hub";
import type { Client, VoiceBasedChannel, VoiceState } from "discord.js";
import { OpusEncoder } from "mediaplex";
import { createTranscriber, MIN_UTTERANCE_BYTES, type Transcriber, WHISPER_MISSING, whisperCliMissing } from "./audio.js";
import { ensureDiscordClient, releaseDiscordClient } from "./client.js";
import type { GatewayCtx } from "@intentic/connector-runtime";
import type { DiscordConnectorConfig } from "./client.js";

// On-demand voice transcription living in this gateway process, so a session outlives any single agent turn. Captures
// per-speaker audio and transcribes each utterance locally with whisper.cpp as it ends (1s silence), dispatching a
// voice_utterance event each time so automations can react mid-call. A module singleton: one session per sandbox.

const fileExists = async (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        () => false,
    );

// Whisper model, downloaded on first use into the workspace volume, kept out of the image. Size and language come from
// connector config; voiceLanguage=en selects the English-specialized ggml-*.en variant instead of the multilingual one.
const ensureWhisperModel = async (ctx: GatewayCtx, config: DiscordConnectorConfig): Promise<string> => {
    const model = config.voiceModel ?? "medium";
    const file = config.voiceLanguage === "en" && model !== "large-v3-turbo" ? `ggml-${model}.en.bin` : `ggml-${model}.bin`;
    const path = join(ctx.workspaceRoot, STATE_DIR, "local", "cache", "whisper", file);
    if (await fileExists(path)) {
        return path;
    }
    ctx.log.info({ model: file }, "downloading whisper model (first voice session)");
    // HF's CAS bridge 403s anonymous plain-HTTP fetches, downloadFile speaks the Xet protocol instead.
    const blob = await downloadFile({ repo: WHISPER_MODEL_REPO, path: file });
    if (blob === null) {
        throw new Error(`whisper model download failed: ${WHISPER_MODEL_REPO} has no ${file}`);
    }
    await mkdir(dirname(path), { recursive: true });
    // Staged then renamed atomically, so a torn download can never look like a finished model.
    const staged = `${path}.${randomUUID()}.part`;
    try {
        // hub's web ReadableStream and the DOM lib's disagree on generics, same object at runtime.
        await pipeline(Readable.fromWeb(blob.stream() as import("node:stream/web").ReadableStream), createWriteStream(staged));
        await rename(staged, path);
    } catch (error) {
        await rm(staged, { force: true });
        throw error;
    }
    return path;
};

interface VoiceSession {
    readonly ctx: GatewayCtx;
    readonly config: DiscordConnectorConfig;
    readonly client: Client;
    readonly channel: VoiceBasedChannel;
    readonly connection: VoiceConnection;
    readonly transcriber: Transcriber;
    readonly startedAt: number;
    // Workspace-relative transcript path, fixed at join, the file exists from the first transcribed utterance.
    readonly relPath: string;
    readonly participants: Set<string>;
    readonly speaking: Set<string>;
    readonly onVoiceState: (oldState: VoiceState, newState: VoiceState) => void;
    ended: boolean;
}

// One shape for the live rewrite (after every utterance) and the final one (with duration + end reason).
const writeTranscript = async (
    ctx: GatewayCtx,
    relPath: string,
    channelName: string,
    startedAt: number,
    participants: Set<string>,
    lines: { line: string }[],
    ended?: { durationSeconds: number; reason: string },
): Promise<void> => {
    const header = [
        `# Voice session: #${channelName}`,
        "",
        `- Started: ${new Date(startedAt).toISOString()}`,
        ...(ended === undefined
            ? ["- Live: session in progress"]
            : [`- Duration: ${Math.round(ended.durationSeconds / 60)} min (${ended.durationSeconds}s)`]),
        `- Participants: ${[...participants].join(", ")}`,
        ...(ended === undefined ? [] : [`- Ended: ${ended.reason}`]),
        "",
    ];
    const abs = join(ctx.workspaceRoot, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `${[...header, ...lines.map(({ line }) => line)].join("\n")}\n`);
};

let session: VoiceSession | undefined;

// Live session snapshot for the status poster.
export const activeVoiceSession = (): { channelId: string; channelName: string; startedAt: number; participants: string[] } | undefined =>
    session === undefined
        ? undefined
        : { channelId: session.channel.id, channelName: session.channel.name, startedAt: session.startedAt, participants: [...session.participants] };

const subscribeSpeaker = (s: VoiceSession, userId: string): void => {
    if (s.ended || s.speaking.has(userId)) {
        return;
    }
    s.speaking.add(userId);
    const startedSpeaking = Date.now();
    const decoder = new OpusEncoder(48_000, 2);
    const chunks: Buffer[] = [];
    const stream = s.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1_000 } });
    stream.on("data", (packet: Buffer) => {
        try {
            chunks.push(decoder.decode(packet));
        } catch {
            // A corrupt packet loses one 20ms frame, never the utterance.
        }
    });
    stream.on("error", (error) => s.ctx.log.warn({ err: error, userId }, "voice receive stream error"));
    stream.on("end", () => {
        s.speaking.delete(userId);
        if (s.ended) {
            return;
        }
        const pcm = Buffer.concat(chunks);
        if (pcm.length < MIN_UTTERANCE_BYTES) {
            return;
        }
        const speaker = s.client.users.cache.get(userId)?.username ?? userId;
        s.participants.add(speaker);
        s.transcriber.push(speaker, startedSpeaking, pcm);
    });
};

// Winds the session down, writes the transcript, and dispatches voice_transcript. Returns the transcript path, or
// undefined if nothing was transcribed.
const endSession = async (s: VoiceSession, reason: string): Promise<string | undefined> => {
    if (s.ended) {
        return undefined;
    }
    s.ended = true;
    session = undefined;
    s.client.off("voiceStateUpdate", s.onVoiceState);
    try {
        s.connection.destroy();
    } catch {
        // Already destroyed by the adapter when the connection dropped.
    }
    const lines = await s.transcriber.flush();
    const durationSeconds = Math.round((Date.now() - s.startedAt) / 1000);
    releaseDiscordClient(s.config.botToken, "voice");
    s.ctx.log.info({ channel: s.channel.name, reason, utterances: lines.length }, "voice session ended");

    const relPath = lines.length === 0 ? undefined : s.relPath;
    if (relPath === undefined) {
        return undefined;
    }
    const participants = [...s.participants];
    await writeTranscript(s.ctx, relPath, s.channel.name, s.startedAt, s.participants, lines, { durationSeconds, reason });
    await s.ctx.daemon.dispatch({
        provider: "discord",
        type: "voice_transcript",
        id: `voice-${s.startedAt}`,
        channelId: s.channel.id,
        author: { id: s.client.user?.id ?? "", name: s.client.user?.username ?? "intentic" },
        content: `voice session in #${s.channel.name} ended (${participants.length} participants, ${Math.round(durationSeconds / 60)} min), transcript at ${relPath}`,
        timestamp: new Date().toISOString(),
        extra: { path: relPath, participants, durationSeconds },
    });
    return relPath;
};

// The CLI-facing surface (human-readable strings, `discord-voice` prints them for the model to read).
export const joinVoice = async (ctx: GatewayCtx, channelId: string, config: DiscordConnectorConfig): Promise<string> => {
    if (session !== undefined) {
        return `Already in #${session.channel.name}: run \`discord-voice leave\` first.`;
    }
    if (await whisperCliMissing()) {
        return WHISPER_MISSING;
    }
    const modelPath = await ensureWhisperModel(ctx, config);
    let client: Client;
    try {
        client = await ensureDiscordClient(config.botToken, "voice");
    } catch (error) {
        releaseDiscordClient(config.botToken, "voice");
        return `Discord login failed: ${errorMessage(error)}`;
    }
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel === null || !channel.isVoiceBased()) {
        releaseDiscordClient(config.botToken, "voice");
        return `Channel ${channelId} is not a voice channel the bot can see: check the id and the bot's Connect permission.`;
    }
    const connection = joinVoiceChannel({
        channelId,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
    });
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
        connection.destroy();
        releaseDiscordClient(config.botToken, "voice");
        return "Couldn't establish the voice connection within 15s: try again.";
    }

    const startedAt = Date.now();
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
    const channelSlug = channel.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
    // Under artifacts/, a finished session's transcript is a durable output, the class that entry names.
    const relPath = join(STATE_DIR, "records", "artifacts", "voice", `${stamp}-${channelSlug}.md`);
    const participants = new Set<string>();
    // Runs inside the transcriber queue after each utterance: rewrites the live transcript, then dispatches
    // voice_utterance; the daemon's batcher debounces bursts into one wake.
    const onLine = async (sorted: { at: number; line: string }[], newLine: string): Promise<void> => {
        await writeTranscript(ctx, relPath, channel.name, startedAt, participants, sorted);
        await ctx.daemon.dispatch({
            provider: "discord",
            type: "voice_utterance",
            id: `voice-${startedAt}-${sorted.length}`,
            channelId: channel.id,
            author: { id: client.user?.id ?? "", name: client.user?.username ?? "intentic" },
            content: newLine,
            timestamp: new Date().toISOString(),
            extra: { path: relPath },
        });
    };
    const s: VoiceSession = {
        ctx,
        config,
        client,
        channel,
        connection,
        transcriber: createTranscriber(modelPath, config.voiceLanguage ?? "auto", startedAt, onLine, (error) =>
            ctx.log.error({ err: error }, "utterance transcription failed"),
        ),
        startedAt,
        relPath,
        participants,
        speaking: new Set(),
        onVoiceState: (oldState, newState) => {
            if (oldState.channelId !== channel.id && newState.channelId !== channel.id) {
                return;
            }
            if (channel.members.filter((member) => !member.user.bot).size === 0) {
                void endSession(s, "everyone left the channel");
            }
        },
        ended: false,
    };
    session = s;
    connection.receiver.speaking.on("start", (userId) => subscribeSpeaker(s, userId));
    // A transient drop re-signals within 5s (discord.js is reconnecting); anything longer is a real end.
    connection.on(VoiceConnectionStatus.Disconnected, () => {
        void Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]).catch(() => endSession(s, "voice connection lost"));
    });
    client.on("voiceStateUpdate", s.onVoiceState);
    return (
        `Joined #${channel.name} and started transcribing live to ${relPath}: the file updates after every utterance ` +
        `(read it any time), each utterance fires a voice_utterance listener event, and when the call ends (or on ` +
        `\`discord-voice leave\`) the finalized transcript fires a voice_transcript event.`
    );
};

export const leaveVoice = async (): Promise<string> => {
    if (session === undefined) {
        return "Not in a voice channel.";
    }
    const name = session.channel.name;
    const path = await endSession(session, "leave");
    return path === undefined
        ? `Left #${name}: nothing was transcribed.`
        : `Left #${name}, transcript at ${path}; the Discord listener automation is firing with it.`;
};

export const voiceStatus = (): string => {
    if (session === undefined) {
        return "Not in a voice channel.";
    }
    const minutes = Math.round((Date.now() - session.startedAt) / 60_000);
    const participants = [...session.participants];
    const transcribed = session.transcriber.transcribed();
    return `In #${session.channel.name} for ${minutes} min, ${transcribed} utterances transcribed, speaking now: ${session.speaking.size}, participants so far: ${participants.length > 0 ? participants.join(", ") : "none yet"}.${transcribed > 0 ? ` Live transcript at ${session.relPath}.` : ""}`;
};

// Process shutdown (SIGTERM): flush what we have so a restart never eats a call's transcript.
export const stopVoice = async (): Promise<void> => {
    if (session !== undefined) {
        await endSession(session, "gateway shutdown");
    }
};
