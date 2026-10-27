import { VoiceClientMessageSchema, type VoiceServerMessage } from "@intentic/sandbox-contract/schemas/voice";
import type { DemoSession, DemoSocket } from "../../transport";
import { frameJson } from "./machineKit";

// THE VOICE (GET /speech/say): text in, the sandbox's speech out, one utterance at a time. The demo synthesises nothing
// on a sandbox, so each utterance is the length its words would take, sent as silence the editor's player schedules
// and counts down as it would real audio, while the visitor's own browser speaks the words aloud. That half lives here,
// on the demo's side of the wire, so the editor plays exactly what a daemon would send it.

const SAMPLE_RATE = 24_000;
// A calm speaking pace, so the player's clock and the browser's voice end about together.
const WORDS_PER_SECOND = 2.6;
// The voice a reply is spoken in until the owner picks one (the Voice settings' default for English).
const DEFAULT_VOICE = `kokoro/af_heart`;
// How far `reply` cuts a written answer when no model is set to shorten it: its first few sentences.
const REPLY_SENTENCES = 3;

const frame = (message: VoiceServerMessage): string => JSON.stringify(message);

// What `reply` becomes before it is heard: the first sentences, with code and links left for the screen.
const spokenOf = (text: string, as: `plain` | `read` | `reply`): string => {
    const prose = text.replace(/```[\s\S]*?```/g, ` `).replace(/`([^`]*)`/g, `$1`).replace(/\[([^\]]*)\]\([^)]*\)/g, `$1`).replace(/\s+/g, ` `).trim();
    return as === `reply` ? (prose.match(/[^.!?]+[.!?]+/g) ?? [prose]).slice(0, REPLY_SENTENCES).join(` `).trim() : prose;
};

// The browser's own voice, where it has one; a browser without speech still gets the whole exchange, silently.
const voice = (): SpeechSynthesis | undefined => (`speechSynthesis` in globalThis ? globalThis.speechSynthesis : undefined);

const speakAloud = (text: string, lang: string): void => {
    const synth = voice();
    if (synth === undefined) {
        return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    synth.cancel();
    synth.speak(utterance);
};

// The utterance's length in silence, as the s16le PCM a daemon sends: one header, then its one binary frame.
const silence = (text: string): ArrayBuffer => {
    const words = Math.max(1, text.split(` `).length);
    const samples = Math.round((words / WORDS_PER_SECOND) * SAMPLE_RATE);
    return new ArrayBuffer(samples * 2);
};

export const speechSaySession: DemoSession = (socket: DemoSocket) => {
    socket.addEventListener(`client`, (event) => {
        if (!(event instanceof MessageEvent)) {
            return;
        }
        const message = VoiceClientMessageSchema.safeParse(frameJson(String(event.data)));
        if (!message.success) {
            return;
        }
        const asked = message.data;
        if (asked.type === `stop`) {
            voice()?.cancel();
            return;
        }
        const text = spokenOf(asked.text, asked.as);
        const lang = asked.lang?.slice(0, 2).toLowerCase() ?? `en`;
        socket.emit(frame({ type: `spoken`, id: asked.id, text, lang, voice: asked.voice ?? DEFAULT_VOICE }));
        const audio = silence(text);
        socket.emit(frame({ type: `audio`, id: asked.id, sampleRate: SAMPLE_RATE, samples: audio.byteLength / 2 }));
        socket.emit(audio);
        socket.emit(frame({ type: `done`, id: asked.id }));
        speakAloud(text, lang);
    });
    socket.addEventListener(`close`, () => voice()?.cancel());
};
