import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { STATE_DIR } from "@intentic/sandbox-contract";
import {
    type AudioPlayer,
    type AudioPlayerError,
    AudioPlayerStatus,
    createAudioPlayer,
    createAudioResource,
    EndBehaviorType,
    entersState,
    joinVoiceChannel,
    StreamType,
    type VoiceConnection,
    VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Client, VoiceBasedChannel, VoiceState } from "discord.js";
import { OpusEncoder } from "mediaplex";
import { createSpeechQueue, createTranscriber, discordFramesOf, MIN_UTTERANCE_BYTES, type SayOutcome, type SpeechQueue, type Transcriber } from "./audio.js";
import { ensureDiscordClient, releaseDiscordClient, visibleChannel } from "./client.js";
import type { GatewayCtx, Speech } from "@intentic/connector-runtime";
import type { DiscordConnectorConfig } from "./client.js";

// On-demand voice transcription living in this gateway process, so a session outlives any single agent turn. Captures
// per-speaker audio and hands each utterance, as it ends (1s silence), to the sandbox's own speech engine (the daemon's
// POST /speech/transcribe: Parakeet for the European languages, Whisper for the rest, both on this machine),
// dispatching a voice_utterance event each time so automations can react mid-call. It speaks too: `sayInVoice` queues
// text for the daemon's voice (POST /speech/say) and plays it into the call, so an agent can answer the people in it. A
// module singleton: one session per sandbox. The language comes from connector config; unset or `auto`, the engine
// detects it.

// How long the voice may stall mid-utterance (the daemon making the next sentence) before playback gives up on it: the
// player's own default is five missed 20 ms frames, which a sentence boundary on a busy machine already exceeds.
const SPEECH_STALL_FRAMES = 15_000 / 20;

// How long `discord-voice say` waits to tell the agent the words are sounding (or why they will not) before answering
// that they are still being made: a first call on a machine fetching its voice model can take minutes.
const SAY_ANSWER_WAIT_MS = 20_000;

// The configured language, or none for the engine to detect: `auto` is how the setting has always spelled that.
const voiceLanguageOf = (config: DiscordConnectorConfig): string | undefined => {
    const language = config.voiceLanguage?.trim();
    return language === undefined || language === "" || language === "auto" ? undefined : language;
};

interface VoiceSession {
    readonly ctx: GatewayCtx;
    readonly config: DiscordConnectorConfig;
    readonly client: Client;
    readonly channel: VoiceBasedChannel;
    readonly connection: VoiceConnection;
    readonly transcriber: Transcriber;
    // What the bot says into the call, one utterance at a time through `player`.
    readonly player: AudioPlayer;
    readonly speech: SpeechQueue;
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
    // Discord sends no bot its own audio, but a speaking event naming it would transcribe its answers back as someone
    // else's words, and wake the automation that made them.
    if (s.ended || s.speaking.has(userId) || userId === s.client.user?.id) {
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
    s.speech.stop();
    s.player.stop(true);
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

// A session Discord ended rather than a command: nobody awaits it, so a transcript that failed to land is logged here.
const endInBackground = (s: VoiceSession, reason: string): void => {
    void endSession(s, reason).catch((error: Error) =>
        s.ctx.log.error({ err: error, channel: s.channel.name, reason }, "voice session end failed; its transcript may not have been dispatched"),
    );
};

// Discord's Opus packets for the daemon's speech, one per 20 ms frame. Encoded here with the codec the receive side
// already decodes with: @discordjs/voice's own raw-PCM path needs an Opus package this image does not carry.
async function* opusPacketsOf(speech: Speech): AsyncGenerator<Buffer> {
    const encoder = new OpusEncoder(48_000, 2);
    for await (const frame of discordFramesOf(speech.pcm, speech.sampleRate)) {
        yield encoder.encode(frame);
    }
}

// Settles when the player has played its resource to the end or `signal` stopped it; a playback that broke rejects.
const played = (player: AudioPlayer, signal: AbortSignal): Promise<void> => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const stop = (): void => void player.stop(true);
    const listeners = {
        ended: (): void => {
            listeners.off();
            resolve();
        },
        broke: (error: AudioPlayerError): void => {
            listeners.off();
            reject(error);
        },
        off: (): void => {
            player.off(AudioPlayerStatus.Idle, listeners.ended);
            player.off("error", listeners.broke);
            signal.removeEventListener("abort", stop);
        },
    };
    player.on(AudioPlayerStatus.Idle, listeners.ended);
    player.on("error", listeners.broke);
    signal.addEventListener("abort", stop, { once: true });
    return promise;
};

// One utterance into the call. The daemon's request and the playback share `signal`, so a stop silences the call and
// the synthesis behind it at once. What the bot says goes into the transcript as its own line once it sounds, so the
// file reads as the conversation it was.
const speakInCall = async (s: VoiceSession, text: string, signal: AbortSignal, started: () => void): Promise<void> => {
    const speech = await s.ctx.daemon.speak(text, { lang: voiceLanguageOf(s.config), signal });
    if (speech === undefined || signal.aborted || s.ended) {
        return;
    }
    const done = played(s.player, signal);
    s.player.play(createAudioResource(Readable.from(opusPacketsOf(speech)), { inputType: StreamType.Opus }));
    started();
    s.transcriber.record(s.client.user?.username ?? "intentic", Date.now(), text);
    await done;
};

// The CLI-facing surface (human-readable strings, `discord-voice` prints them for the model to read).
export const joinVoice = async (ctx: GatewayCtx, channelId: string, config: DiscordConnectorConfig): Promise<string> => {
    if (session !== undefined) {
        return `Already in #${session.channel.name}: run \`discord-voice leave\` first.`;
    }
    let client: Client;
    try {
        client = await ensureDiscordClient(config.botToken, "voice");
    } catch (error) {
        releaseDiscordClient(config.botToken, "voice");
        return `Discord login failed: ${errorMessage(error)}`;
    }
    let channel: Awaited<ReturnType<typeof visibleChannel>>;
    try {
        channel = await visibleChannel(client, channelId);
    } catch (error) {
        // A sentence for the agent, as a failed login is: the gateway's catch-all would answer only "500".
        releaseDiscordClient(config.botToken, "voice");
        return `Couldn't look up channel ${channelId}: ${errorMessage(error)}`;
    }
    if (channel === null || !channel.isVoiceBased()) {
        releaseDiscordClient(config.botToken, "voice");
        return `Channel ${channelId} is not a voice channel the bot can see: check the id and the bot's Connect permission.`;
    }
    const connection = joinVoiceChannel({
        channelId,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        // Unmuted, or nothing the bot says is heard; undeafened, or nothing is heard to transcribe.
        selfDeaf: false,
        selfMute: false,
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
    // voice_utterance; the daemon's batcher debounces bursts into one wake. The bot's own lines wake nothing: whoever
    // had it say them already knows what it said.
    const onLine = async (sorted: { at: number; line: string }[], newLine: string, heard: boolean): Promise<void> => {
        await writeTranscript(ctx, relPath, channel.name, startedAt, participants, sorted);
        if (!heard) {
            return;
        }
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
    const player = createAudioPlayer({ behaviors: { maxMissedFrames: SPEECH_STALL_FRAMES } });
    // A player with no error listener throws its error out of the process; the utterance it broke hears it too.
    player.on("error", (error) => ctx.log.warn({ err: error, channel: channel.name }, "voice playback failed"));
    connection.subscribe(player);
    const s: VoiceSession = {
        ctx,
        config,
        client,
        channel,
        connection,
        transcriber: createTranscriber(ctx.daemon.transcribe, voiceLanguageOf(config), startedAt, onLine, (error) =>
            ctx.log.error({ err: error }, "utterance transcription failed"),
        ),
        player,
        speech: createSpeechQueue(
            (text, signal, started) => speakInCall(s, text, signal, started),
            (error) => ctx.log.error({ err: error, channel: channel.name }, "speaking into the call failed"),
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
                endInBackground(s, "everyone left the channel");
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
        ]).catch(() => endInBackground(s, "voice connection lost"));
    });
    client.on("voiceStateUpdate", s.onVoiceState);
    return (
        `Joined #${channel.name} and started transcribing live to ${relPath}: the file updates after every utterance ` +
        `(read it any time), each utterance fires a voice_utterance listener event, and when the call ends (or on ` +
        `\`discord-voice leave\`) the finalized transcript fires a voice_transcript event. Answer the call aloud with ` +
        `\`discord-voice say "<text>"\`.`
    );
};

// What `discord-voice say` answers once the utterance has begun, or could not.
const sayAnswer = (channelName: string, outcome: SayOutcome | undefined): string => {
    switch (outcome?.kind) {
        case undefined:
            return `Queued in #${channelName}: the voice is still being made, it plays as soon as it is ready.`;
        case "speaking":
            return `Speaking in #${channelName}.`;
        case "silent":
            return "Nothing in that text could be said aloud.";
        case "stopped":
            return "Stopped before it was said.";
        case "failed":
            return `Couldn't speak in #${channelName}: ${outcome.reason}`;
    }
};

// Says `text` into the call, after whatever is already being said. Answers once it sounds (or why it will not), or
// right away when it waits behind others, so the agent learns of a voice that cannot speak while it can still write.
export const sayInVoice = async (text: string): Promise<string> => {
    const s = session;
    if (s === undefined) {
        return "Not in a voice channel.";
    }
    const { ahead, begun } = s.speech.say(text);
    if (ahead > 0) {
        return `Queued in #${s.channel.name}, after ${ahead} utterance${ahead === 1 ? "" : "s"} still to say.`;
    }
    const waited = new AbortController();
    const outcome = await Promise.race([begun, sleep(SAY_ANSWER_WAIT_MS, { signal: waited.signal }).then(() => undefined)]);
    waited.abort();
    return sayAnswer(s.channel.name, outcome);
};

// Cuts what the bot is saying and drops what it was still to say.
export const stopSpeaking = (): string => {
    if (session === undefined) {
        return "Not in a voice channel.";
    }
    const cut = session.speech.stop();
    if (cut === 0) {
        return "Nothing was being said.";
    }
    return `Stopped speaking in #${session.channel.name}${cut > 1 ? `, and dropped ${cut - 1} utterance${cut === 2 ? "" : "s"} still to say` : ""}.`;
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
    const saying = session.speech.size();
    return `In #${session.channel.name} for ${minutes} min, ${transcribed} utterances transcribed, speaking now: ${session.speaking.size}, participants so far: ${participants.length > 0 ? participants.join(", ") : "none yet"}.${saying > 0 ? ` Saying ${saying} utterance${saying === 1 ? "" : "s"} (\`discord-voice stop\` cuts them).` : ""}${transcribed > 0 ? ` Live transcript at ${session.relPath}.` : ""}`;
};

// Process shutdown (SIGTERM): flush what we have so a restart never eats a call's transcript.
export const stopVoice = async (): Promise<void> => {
    if (session !== undefined) {
        await endSession(session, "gateway shutdown");
    }
};
