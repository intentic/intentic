import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
// CJS with native bindings — its named exports aren't statically analyzable, so ESM must default-import.
import opus from "@discordjs/opus";
import { EndBehaviorType, entersState, joinVoiceChannel, type VoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";
import type { CliConfig } from "@intentic/sandbox-contract";
import type { Client, VoiceBasedChannel, VoiceState } from "discord.js";
import { dispatchListenerMessage } from "../automations/listeners.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { ensureDiscordClient, releaseDiscordClient } from "./client.js";

/* On-demand voice transcription: the agent joins a voice channel via its MCP tools (join_voice/leave_voice/
 * voice_status), the daemon captures per-speaker audio through the shared discord.js client, and transcribes
 * each utterance locally with whisper.cpp as it ends (1s of silence). Every transcribed utterance rewrites the
 * live transcript in the workspace and dispatches a voice_utterance listener event (batched by the listener
 * debounce), so automations can react mid-call and the agent can Read the file at any time. When the call ends
 * — everyone left, leave_voice, or the connection died — the transcript is finalized and a voice_transcript
 * listener event fires so the automation wakes the agent to turn it into artifacts (notes, task lists).
 *
 * whisper-cli is NOT in the base image: the discord capability's overlay fragment composes it into this
 * sandbox's environment (see capabilities/cli/providers.ts), so only sandboxes that connect Discord carry it.
 * join_voice detects the missing binary and points at the owner-run rebuild that applies the overlay.
 *
 * A module singleton (like agent-requests' bridge): sessions outlive the agent turn that started them, and
 * both the MCP tools and shutdown reach it directly.
 * ponytail: one session per sandbox — a map per channel if concurrent calls ever matter. */

// The discord cli capability config — botToken plus the voice knobs. The cli config schema is now open
// (`provider` + string fields, validated against the discord connector's declared fields), so this is a plain
// shape rather than a schema-union arm.
export interface DiscordCliConfig {
    readonly provider: string;
    readonly botToken: string;
    readonly voiceModel?: string;
    readonly voiceLanguage?: string;
}

// The whisper model, downloaded on first use into the workspace volume (kept out of the image). Size and
// language come from the capability config: default `medium` (~1.5GB, best accuracy/CPU trade-off for
// non-English speech) and `auto` language detection; voiceLanguage=en selects the English-specialized
// ggml-*.en variant — the only language-specialized models whisper.cpp publishes.
const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
// Utterances shorter than this are dropped unheard — sub-quarter-second blips (key clicks, coughs) only feed
// whisper hallucinations. 48kHz stereo s16le = 192,000 bytes/s.
const MIN_UTTERANCE_BYTES = 48_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;

export type ExecFn = (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
const defaultExec: ExecFn = promisify(execFile);

// The tool result the model reads when whisper isn't provisioned — it routes the agent to the pending rebuild
// instead of a doomed retry loop (or a needless overlay proposal: the fragment is already composed).
export const WHISPER_MISSING =
    "whisper-cli isn't installed in this sandbox yet. It's part of the environment overlay that was composed when " +
    "Discord was connected — the sandbox needs a one-time rebuild. Ask the owner to run the rebuild command shown on " +
    "the Sandbox page's Environment card, and don't retry join_voice (or propose an overlay) until it has landed.";

// ENOENT on spawn ⇒ the binary isn't on PATH. Any other outcome (including a non-zero exit) means it exists.
export const whisperCliMissing = async (exec: ExecFn = defaultExec): Promise<boolean> => {
    try {
        await exec("whisper-cli", ["--help"], { timeout: 10_000 });
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
};

// ---- pure audio helpers (exported for tests) ----

// 48kHz stereo s16le → 16kHz mono s16le: average each group of 3 stereo frames (6 samples) into one.
// ponytail: naive decimation without a low-pass — fine for speech; swap in a real resampler if quality nags.
export const to16kMonoPcm = (stereo48k: Buffer): Buffer => {
    const outFrames = Math.floor(stereo48k.length / 12);
    const out = Buffer.alloc(outFrames * 2);
    for (let i = 0; i < outFrames; i += 1) {
        let sum = 0;
        for (let sample = 0; sample < 6; sample += 1) {
            sum += stereo48k.readInt16LE(i * 12 + sample * 2);
        }
        out.writeInt16LE(Math.round(sum / 6), i * 2);
    }
    return out;
};

// Minimal RIFF/WAVE header for 16kHz mono s16le — what whisper-cli expects.
export const wavOf = (pcm16kMono: Buffer): Buffer => {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm16kMono.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(16_000, 24); // sample rate
    header.writeUInt32LE(32_000, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(pcm16kMono.length, 40);
    return Buffer.concat([header, pcm16kMono]);
};

// Whisper's stdout for one utterance → clean single-line text, or undefined for silence/noise-only output
// (whisper renders non-speech as bracketed annotations like [BLANK_AUDIO] or (wind blowing)).
export const cleanTranscription = (stdout: string): string | undefined => {
    const text = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !/^[[(].*[\])]$/.test(line))
        .join(" ")
        .trim();
    return text === "" ? undefined : text;
};

const elapsedLabel = (ms: number): string => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

// ---- transcriber: serialized whisper queue (exported for tests) ----

export interface Transcriber {
    readonly push: (speaker: string, atMs: number, pcm48kStereo: Buffer) => void;
    // Wait out the queue and return the transcript lines in speech order.
    readonly flush: () => Promise<{ at: number; line: string }[]>;
    readonly transcribed: () => number;
}

// One whisper-cli run at a time — transcription is CPU-bound and the sandbox is small; utterances queue.
// `onLine` runs inside the queue after each transcribed line (live file write + utterance dispatch); its
// failures land in onError like a whisper failure would.
export const createTranscriber = (
    modelPath: string,
    language: string,
    startedAt: number,
    onLine: (sorted: { at: number; line: string }[], newLine: string) => Promise<void>,
    onError: (error: unknown) => void,
    exec: ExecFn = defaultExec,
): Transcriber => {
    const lines: { at: number; line: string }[] = [];
    let queue: Promise<void> = Promise.resolve();
    return {
        push: (speaker, atMs, pcm) => {
            queue = queue
                .then(async () => {
                    const wavPath = join(tmpdir(), `intentic-utterance-${randomUUID()}.wav`);
                    await writeFile(wavPath, wavOf(to16kMonoPcm(pcm)));
                    try {
                        // whisper-cli defaults to -l en, silently mangling other languages — always pass one.
                        const { stdout } = await exec(
                            "whisper-cli",
                            ["-m", modelPath, "-f", wavPath, "-l", language, "--no-timestamps", "--no-prints"],
                            { timeout: TRANSCRIBE_TIMEOUT_MS },
                        );
                        const text = cleanTranscription(stdout);
                        if (text !== undefined) {
                            const line = `[${elapsedLabel(atMs - startedAt)}] ${speaker}: ${text}`;
                            lines.push({ at: atMs, line });
                            await onLine(
                                lines.toSorted((a, b) => a.at - b.at),
                                line,
                            );
                        }
                    } finally {
                        await rm(wavPath, { force: true });
                    }
                })
                .catch(onError);
        },
        flush: async () => {
            await queue;
            return lines.toSorted((a, b) => a.at - b.at);
        },
        transcribed: () => lines.length,
    };
};

// ---- model provisioning ----

const ensureWhisperModel = async (services: Services, config: DiscordCliConfig): Promise<string> => {
    const model = config.voiceModel ?? "medium";
    // English-specialized variants exist for every size except large-v3-turbo and beat the multilingual ones.
    const file = config.voiceLanguage === "en" && model !== "large-v3-turbo" ? `ggml-${model}.en.bin` : `ggml-${model}.bin`;
    const path = join(services.workspace.root, ".intentic", "whisper", file);
    if ((await services.files.size(path)) !== undefined) {
        return path;
    }
    services.logger.info({ model: file }, "downloading whisper model (first voice session)");
    const response = await fetch(`${MODEL_BASE_URL}/${file}`);
    if (!response.ok || response.body === null) {
        throw new Error(`whisper model download failed: HTTP ${response.status} for ${file}`);
    }
    await mkdir(dirname(path), { recursive: true });
    // Stream straight to disk (up to ~1.5GB — never buffer it); a torn download is removed so the next join
    // retries instead of feeding whisper a truncated file.
    try {
        // undici's web ReadableStream and the DOM lib's disagree on generics — same object at runtime.
        await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(path));
    } catch (error) {
        await rm(path, { force: true });
        throw error;
    }
    return path;
};

// ---- the session ----

interface VoiceSession {
    readonly services: Services;
    readonly wake: WakeFn;
    readonly config: DiscordCliConfig;
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
    services: Services,
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
    await services.files.write(join(services.workspace.root, relPath), `${[...header, ...lines.map(({ line }) => line)].join("\n")}\n`);
};

let session: VoiceSession | undefined;

// Live session snapshot for the activity status route.
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
    const decoder = new opus.OpusEncoder(48_000, 2);
    const chunks: Buffer[] = [];
    const stream = s.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1_000 } });
    stream.on("data", (packet: Buffer) => {
        try {
            chunks.push(decoder.decode(packet));
        } catch {
            // A corrupt packet loses one 20ms frame, never the utterance.
        }
    });
    stream.on("error", (error) => s.services.logger.warn({ err: error, userId }, "voice receive stream error"));
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
    s.services.logger.info({ channel: s.channel.name, reason, utterances: lines.length }, "voice session ended");

    // Every end lands in the activity log; the transcript path only when something was transcribed.
    const relPath = lines.length === 0 ? undefined : s.relPath;
    const participants = [...s.participants];
    void s.services.activity
        .append({
            provider: "discord",
            direction: "system",
            type: "voice.session_ended",
            channelId: s.channel.id,
            extra: { reason, participants, durationSeconds, ...(relPath !== undefined ? { path: relPath } : {}) },
        })
        .catch((error: unknown) => s.services.logger.warn({ err: error }, "activity append failed"));
    if (relPath === undefined) {
        return undefined;
    }
    await writeTranscript(s.services, relPath, s.channel.name, s.startedAt, s.participants, lines, { durationSeconds, reason });

    await dispatchListenerMessage(
        s.services,
        {
            provider: "discord",
            type: "voice_transcript",
            id: `voice-${s.startedAt}`,
            channelId: s.channel.id,
            author: { id: s.client.user?.id ?? "", name: s.client.user?.username ?? "intentic" },
            content: `voice session in #${s.channel.name} ended (${participants.length} participants, ${Math.round(durationSeconds / 60)} min) — transcript at ${relPath}`,
            timestamp: new Date().toISOString(),
            extra: { path: relPath, participants, durationSeconds },
        },
        s.wake,
    );
    return relPath;
};

// ---- the MCP tool surface (human-readable strings — these are tool results the model reads) ----

// `wake` is passed by the caller (the MCP tool server hands over streamAgent) — importing it here would
// close a module cycle with agent.routes.
export const joinVoice = async (services: Services, channelId: string, wake: WakeFn, config: DiscordCliConfig): Promise<string> => {
    if (session !== undefined) {
        return `Already in #${session.channel.name} — call leave_voice first.`;
    }
    // Before the model download and the gateway connection: no transcriber, no session.
    if (await whisperCliMissing()) {
        return WHISPER_MISSING;
    }
    const modelPath = await ensureWhisperModel(services, config);
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
    const relPath = join(".intentic", "transcripts", `${stamp}-${channelSlug}.md`);
    const participants = new Set<string>();
    // Runs inside the transcriber queue after each utterance: rewrite the live transcript, then dispatch a
    // voice_utterance event — the listener batcher debounces bursts into one automation wake.
    const onLine = async (sorted: { at: number; line: string }[], newLine: string): Promise<void> => {
        await writeTranscript(services, relPath, channel.name, startedAt, participants, sorted);
        await dispatchListenerMessage(
            services,
            {
                provider: "discord",
                type: "voice_utterance",
                id: `voice-${startedAt}-${sorted.length}`,
                channelId: channel.id,
                author: { id: client.user?.id ?? "", name: client.user?.username ?? "intentic" },
                content: newLine,
                timestamp: new Date().toISOString(),
                extra: { path: relPath },
            },
            wake,
        );
    };
    const s: VoiceSession = {
        services,
        wake,
        config,
        client,
        channel,
        connection,
        transcriber: createTranscriber(modelPath, config.voiceLanguage ?? "auto", startedAt, onLine, (error) =>
            services.logger.error({ err: error }, "utterance transcription failed"),
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
    void services.activity
        .append({ provider: "discord", direction: "system", type: "voice.session_started", channelId, extra: { channel: channel.name } })
        .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
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
        `leave_voice) the finalized transcript fires a voice_transcript event.`
    );
};

export const leaveVoice = async (): Promise<string> => {
    if (session === undefined) {
        return "Not in a voice channel.";
    }
    const name = session.channel.name;
    const path = await endSession(session, "leave_voice");
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

// Daemon shutdown: flush what we have so a restart never eats a call's transcript.
export const stopVoice = async (): Promise<void> => {
    if (session !== undefined) {
        await endSession(session, "daemon shutdown");
    }
};
