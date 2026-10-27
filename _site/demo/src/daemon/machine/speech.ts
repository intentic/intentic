import { SpeechClientMessageSchema, type SpeechServerMessage, type SpeechStatus, speechEngineFor, speechLanguage } from "@intentic/sandbox-contract/schemas/speech";
import type { RawJsonOutput } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import type { DemoSession, DemoSocket } from "../../transport";
import { frameJson } from "./machineKit";

// Speech on the sandbox (the daemon's speech/ and voice/): dictation heard by a model on this machine, a wake word
// claimed by one device, and replies spoken back. The demo hears nothing, so dictation answers with phrases a person
// at this shop would plausibly say, a word at a time as the live stream does; speaking sends the audio's length in
// silence for the player's clock and, on the demo's side only, has the browser's own voice say the words.

// The dictation model is on disk here from the start, as on a provisioned sandbox; arming it loads it into memory.
const armed = new Set<string>();

export const speechStatus = (lang: string | null): SpeechStatus => {
    const language = speechLanguage(lang ?? undefined) ?? `en`;
    return { provisioned: true, model: `ready`, engine: speechEngineFor(language), loaded: armed.has(language) };
};

export const prepareSpeech = (lang: string | null): SpeechStatus => {
    armed.add(speechLanguage(lang ?? undefined) ?? `en`);
    return speechStatus(lang);
};

// What a person at acme-shop says to its agents, in turn; Polish for a Polish reader, English for everyone else.
const PHRASES = {
    en: [
        `Check why the checkout still shows free shipping to Germany.`,
        `Run the checkout tests again and tell me what failed.`,
        `Draft a reply to the supplier about the late September delivery.`,
        `Open a pull request with the shipping rate fix when the tests pass.`,
    ],
    pl: [
        `Sprawdź, dlaczego koszyk nadal pokazuje darmową wysyłkę do Niemiec.`,
        `Uruchom jeszcze raz testy koszyka i powiedz mi, co nie przeszło.`,
        `Przygotuj odpowiedź do dostawcy w sprawie spóźnionej dostawy.`,
    ],
} satisfies Readonly<Record<string, readonly string[]>>;
const heard = { next: 0 };

const phrase = (lang: string | null): string => {
    const list = speechLanguage(lang ?? undefined) === `pl` ? PHRASES.pl : PHRASES.en;
    const said = list[heard.next % list.length] ?? ``;
    heard.next += 1;
    return said;
};

export const transcribe = (lang: string | null): RawJsonOutput<`POST /speech/transcribe`> => ({ text: phrase(lang) });

// Two devices hearing the same wake word: the first to claim it acts, the others stay quiet for the hold it asked.
const LONE_WAKE_MS = 4_000;
const claim = { device: ``, until: 0 };

export const claimWake = (device: string, holdMs: number | undefined): RawJsonOutput<`POST /speech/wake`> => {
    const now = Date.now();
    if (claim.device !== device && claim.until > now) {
        return { granted: false };
    }
    claim.device = device;
    claim.until = now + (holdMs ?? LONE_WAKE_MS);
    return { granted: true };
};

// THE LIVE PHRASE STREAM (GET /speech/stream): status first, then for each phrase the device begins, its words as
// running guesses while it is spoken and the whole phrase once it ends.
const PARTIAL_MS = 380;

// One phrase being spoken: its words, how many the running guess has shown, and the clock showing the next.
interface LivePhrase {
    readonly words: readonly string[];
    shown: number;
    timer: ReturnType<typeof setInterval> | undefined;
}

const streamFrame = (message: SpeechServerMessage): string => JSON.stringify(message);

export const speechStreamSession: DemoSession = (socket: DemoSocket) => {
    const lang = new URL(socket.url).searchParams.get(`lang`);
    const guesses = new URL(socket.url).searchParams.get(`guesses`) !== `0`;
    armed.add(speechLanguage(lang ?? undefined) ?? `en`);
    socket.emit(streamFrame({ type: `status`, status: speechStatus(lang) }));
    const phrases = new Map<number, LivePhrase>();
    const begin = (id: number): void => {
        const words = phrase(lang).split(` `);
        const live: LivePhrase = { words, shown: 0, timer: undefined };
        phrases.set(id, live);
        if (guesses) {
            live.timer = setInterval(() => {
                live.shown = Math.min(live.words.length, live.shown + 1);
                socket.emit(streamFrame({ type: `partial`, id, text: live.words.slice(0, live.shown).join(` `) }));
            }, PARTIAL_MS);
        }
    };
    const end = (id: number, keep: boolean): void => {
        const live = phrases.get(id);
        clearInterval(live?.timer);
        phrases.delete(id);
        if (keep && live !== undefined) {
            socket.emit(streamFrame({ type: `final`, id, text: live.words.join(` `), decodeMs: 140 + live.words.length * 9 }));
        }
    };
    socket.addEventListener(`client`, (event) => {
        // Binary frames are the audio itself, which there is nothing here to hear.
        if (!(event instanceof MessageEvent) || event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) {
            return;
        }
        const message = SpeechClientMessageSchema.safeParse(frameJson(String(event.data)));
        if (!message.success) {
            return;
        }
        if (message.data.type === `begin`) {
            begin(message.data.id);
        } else {
            end(message.data.id, message.data.type === `end`);
        }
    });
    socket.addEventListener(`close`, () => {
        for (const id of phrases.keys()) {
            end(id, false);
        }
    });
};
