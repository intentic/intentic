import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { STATE_DIR } from "@intentic/sandbox-contract";
import { EndBehaviorType, entersState, joinVoiceChannel, type VoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";
import { downloadFile } from "@huggingface/hub";
import type { Client, VoiceBasedChannel, VoiceState } from "discord.js";
// The Opus decoder for received voice. napi-rs, so the platform binding arrives as a prebuilt optional
// dependency and nothing compiles on install — unlike @discordjs/opus, whose node-pre-gyp installer fetched and
// untarred a binary at install time and needed a `tar` override to stay off a live advisory. Same class, same
// `(sampleRate, channels)` constructor, same `decode(Buffer): Buffer`; decoded output matches the old binding to
// within one 16-bit LSB (~110 dB SNR), which is libopus rounding and inaudible to whisper.
import { OpusEncoder } from "mediaplex";
import { createTranscriber, MIN_UTTERANCE_BYTES, type Transcriber, WHISPER_MISSING, whisperCliMissing } from "./audio.js";
import { ensureDiscordClient, releaseDiscordClient } from "./client.js";
import type { GatewayCtx } from "@intentic/connector-runtime";
import type { DiscordConnectorConfig } from "./client.js";

/* On-demand voice transcription living IN this gateway process (so a session outlives any single agent turn):
 * the agent joins a voice channel via the `discord-voice` CLI (→ this process's HTTP control server), we capture
 * per-speaker audio through the shared discord.js client and transcribe each utterance locally with whisper.cpp as
 * it ends (1s of silence). Every transcribed utterance rewrites the live transcript in the workspace and dispatches
 * a voice_utterance listener event (POST /listeners/discord/dispatch), so automations can react mid-call and the
 * agent can read the file at any time. When the call ends (everyone left, `discord-voice leave`, or the connection
 * died) the transcript is finalized and a voice_transcript event fires so an automation can turn it into artifacts.
 *
 * whisper-cli is NOT in the base image: the discord connector's overlay fragment composes it in, so only sandboxes
 * that connect Discord carry it. A join detects the missing binary and points at the owner-run rebuild.
 *
 * A module singleton: one session per sandbox. ponytail — a map per channel if concurrent calls ever matter. */

const MODEL_REPO = "ggerganov/whisper.cpp";

const fileExists = async (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        () => false,
    );

// The whisper model, downloaded on first use into the workspace volume (kept out of the image). Size and language
// come from the connector config: default `medium` (~1.5GB, best accuracy/CPU trade-off for non-English speech)
// and `auto` detection; voiceLanguage=en selects the English-specialized ggml-*.en variant.
const ensureWhisperModel = async (ctx: GatewayCtx, config: DiscordConnectorConfig): Promise<string> => {
    const model = config.voiceModel ?? "medium";
    const file = config.voiceLanguage === "en" && model !== "large-v3-turbo" ? `ggml-${model}.en.bin` : `ggml-${model}.bin`;
    const path = join(ctx.workspaceRoot, STATE_DIR, "local", "cache", "whisper", file);
    if (await fileExists(path)) {
        return path;
    }
    ctx.log.info({ model: file }, "downloading whisper model (first voice session)");
    // HF's CAS bridge 403s anonymous plain-HTTP fetches — downloadFile speaks the Xet protocol instead.
    const blob = await downloadFile({ repo: MODEL_REPO, path: file });
    if (blob === null) {
        throw new Error(`whisper model download failed: ${MODEL_REPO} has no ${file}`);
    }
    await mkdir(dirname(path), { recursive: true });
    // Stream straight to disk (up to ~1.5GB — never buffer it), landing BESIDE the model and only then taking
    // its place: presence here is a bare stat, so a file growing in place is indistinguishable from a finished
    // one — a torn download would look permanently present and every later join would feed whisper-cli a
    // half-written model. rename is atomic within the directory, so the model is either absent or whole. The
    // staged name is unique per attempt because the composer's own voice downloads into this same directory.
    const staged = `${path}.${randomUUID()}.part`;
    try {
        // hub's web ReadableStream and the DOM lib's disagree on generics — same object at runtime.
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
    // Workspace-relative transcript path, fixed at join — the file exists from the first transcribed utterance.
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
        `# Voice session — #${channelName}`,
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

// Wind the session down, write the transcript, and dispatch the voice_transcript listener event. Returns the
// workspace-relative transcript path, or undefined when nothing was transcribed.
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
        content: `voice session in #${s.channel.name} ended (${participants.length} participants, ${Math.round(durationSeconds / 60)} min) — transcript at ${relPath}`,
        timestamp: new Date().toISOString(),
        extra: { path: relPath, participants, durationSeconds },
    });
    return relPath;
};

// The CLI-facing surface (human-readable strings — `discord-voice` prints them for the model to read).
export const joinVoice = async (ctx: GatewayCtx, channelId: string, config: DiscordConnectorConfig): Promise<string> => {
    if (session !== undefined) {
        return `Already in #${session.channel.name} — run \`discord-voice leave\` first.`;
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
        return `Discord login failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel === null || !channel.isVoiceBased()) {
        releaseDiscordClient(config.botToken, "voice");
        return `Channel ${channelId} is not a voice channel the bot can see — check the id and the bot's Connect permission.`;
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
        return "Couldn't establish the voice connection within 15s — try again.";
    }

    const startedAt = Date.now();
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
    const channelSlug = channel.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
    // Under artifacts/ — a finished session's transcript is a durable output, the class that entry names.
    const relPath = join(STATE_DIR, "records", "artifacts", "voice", `${stamp}-${channelSlug}.md`);
    const participants = new Set<string>();
    // Runs inside the transcriber queue after each utterance: rewrite the live transcript, then dispatch a
    // voice_utterance event — the daemon's listener batcher debounces bursts into one automation wake.
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
        `Joined #${channel.name} and started transcribing live to ${relPath} — the file updates after every utterance ` +
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
        ? `Left #${name} — nothing was transcribed.`
        : `Left #${name} — transcript at ${path}; the Discord listener automation is firing with it.`;
};

export const voiceStatus = (): string => {
    if (session === undefined) {
        return "Not in a voice channel.";
    }
    const minutes = Math.round((Date.now() - session.startedAt) / 60_000);
    const participants = [...session.participants];
    const transcribed = session.transcriber.transcribed();
    return (
        `In #${session.channel.name} for ${minutes} min — ${transcribed} utterances transcribed, speaking now: ` +
        `${session.speaking.size}, participants so far: ${participants.length > 0 ? participants.join(", ") : "none yet"}.` +
        (transcribed > 0 ? ` Live transcript at ${session.relPath}.` : "")
    );
};

// Process shutdown (SIGTERM): flush what we have so a restart never eats a call's transcript.
export const stopVoice = async (): Promise<void> => {
    if (session !== undefined) {
        await endSession(session, "gateway shutdown");
    }
};
