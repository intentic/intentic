import {
    type CloudVoice,
    type CloudVoiceProvider,
    isCloudVoiceEngine,
    VOICE_ID,
    type VoiceId,
    type VoiceInfo,
    type VoiceSettings,
    type VoicesView,
    voiceEngineOf,
    voiceNameOf,
} from "@intentic/sandbox-contract/schemas/voice";
import { formatCount, formatFixed } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// The Voice card's choices, worked out from the sandbox's answer to GET /speech/voices and the voice settings
// (schemas/voice.ts). What speaks a language follows the daemon's own rule (speech/voice/voice.ts `speakerFor`): the
// owner's pick for it, else the connected provider where it speaks the language, else this sandbox's default for it.

/** Which voice the owner picked for each language, as the settings hold it. */
type Picks = VoiceSettings[`voices`];

/** One option of a select: the value written, and the words shown. */
export interface Choice {
    readonly value: string;
    readonly label: string;
}

/** Proper names, the same in every language. */
export const PROVIDER_NAMES = {
    elevenlabs: `ElevenLabs`,
    cartesia: `Cartesia`,
    deepgram: `Deepgram`,
} as const satisfies Record<CloudVoiceProvider, string>;

// The secret name a newly picked provider starts on: the name its own documentation gives the key, so a key stored
// the obvious way is found without the owner typing anything.
export const PROVIDER_SECRETS = {
    elevenlabs: `ELEVENLABS_API_KEY`,
    cartesia: `CARTESIA_API_KEY`,
    deepgram: `DEEPGRAM_API_KEY`,
} as const satisfies Record<CloudVoiceProvider, string>;

/** The paces offered; a speed set some other way (0.5–2) is offered beside them rather than shown as something else. */
export const SPEEDS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

// What speaks a language no local voice does, as the daemon falls back.
const FALLBACK_LANGUAGE = `en`;

/** `pl-PL` → `pl`: the language a voice speaks, from a locale tag. */
export const primaryLanguage = (tag: string): string => (tag.split(`-`)[0] ?? tag).toLowerCase();

/** A language's name in the reader's language, capitalised for a list ("Polish", "Polski"). */
export const languageName = (language: string, locale: string): string => {
    const name = new Intl.DisplayNames([locale], { type: `language` }).of(language) ?? language;
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
};

/** The pace as a multiplier, written the reader's way ("1,25×" in Polish), with only the decimals it has. */
export const speedLabel = (speed: number): string => `${formatFixed(speed, (String(speed).split(`.`)[1] ?? ``).length > 1 ? 2 : speed % 1 === 0 ? 0 : 1)}×`;

export const speedChoices = (current: number): Choice[] => {
    const speeds = SPEEDS.includes(current) ? SPEEDS : [...SPEEDS, current].toSorted((a, b) => a - b);
    return speeds.map((speed) => ({ value: String(speed), label: speedLabel(speed) }));
};

// The provider's languages, only while the voices read and the settings agree on which provider it is: a read from
// before the provider changed speaks for the old one.
const cloudLanguages = (view: VoicesView | undefined, cloud: CloudVoice | undefined): readonly string[] =>
    view?.cloud !== undefined && cloud !== undefined && view.cloud.provider === cloud.provider ? view.cloud.languages : [];

/** The connected provider speaks this language, so it speaks it unless a voice here was picked for it. */
export const providerSpeaks = (view: VoicesView | undefined, cloud: CloudVoice | undefined, language: string): boolean =>
    cloudLanguages(view, cloud).includes(language);

/** Every language something can speak: this sandbox's voices', and the connected provider's. */
export const languageChoices = (view: VoicesView, cloud: CloudVoice | undefined, locale: string): Choice[] =>
    [...new Set([...Object.keys(view.defaults), ...cloudLanguages(view, cloud)])]
        .map((language) => ({ value: language, label: languageName(language, locale) }))
        .toSorted((a, b) => a.label.localeCompare(b.label, locale));

/** The language the card opens on: the reader's own where something speaks it, English otherwise. */
export const initialLanguage = (choices: readonly Choice[], locale: string): string => {
    const own = primaryLanguage(locale);
    return choices.some((choice) => choice.value === own) ? own : FALLBACK_LANGUAGE;
};

/** A provider's voice as an id, `<provider>/default` for its own default; undefined for a name the id cannot carry. */
export const cloudVoiceId = (provider: CloudVoiceProvider, name: string): VoiceId | undefined => {
    const id = `${provider}/${name === `` ? `default` : name}`;
    return VOICE_ID.test(id) ? id : undefined;
};

const genderWord = (gender: NonNullable<VoiceInfo[`gender`]>): string =>
    gender === `female` ? t(`sandbox.agentVoice.female`) : t(`sandbox.agentVoice.male`);

/** A local voice as a person tells it apart: "Heart · US · female". */
export const localVoiceLabel = (info: VoiceInfo): string =>
    [info.label, info.accent, info.gender === undefined ? undefined : genderWord(info.gender)].filter((part) => part !== undefined).join(` · `);

// Decimal megabytes, the size a download is quoted in: Kokoro is "350 MB", as its release lists it.
const downloadSize = (bytes: number): string => `${formatCount(Math.round(bytes / 1_000_000))} MB`;

// A voice whose model is not here yet says what the first preview of it costs.
const localChoiceLabel = (info: VoiceInfo): string =>
    info.installed === false && info.bytes !== undefined
        ? t(`sandbox.agentVoice.downloads`, { voice: localVoiceLabel(info), size: downloadSize(info.bytes) })
        : localVoiceLabel(info);

const cloudVoiceLabel = (provider: CloudVoiceProvider, name: string): string =>
    name === `` || name === `default`
        ? t(`sandbox.agentVoice.providerDefault`, { provider: PROVIDER_NAMES[provider] })
        : t(`sandbox.agentVoice.providerVoice`, { provider: PROVIDER_NAMES[provider], voice: name });

/** Any voice id in words: a provider's, or one of this sandbox's by its name, accent and gender. */
export const voiceLabel = (id: VoiceId, view: VoicesView | undefined): string => {
    const engine = voiceEngineOf(id);
    if (isCloudVoiceEngine(engine)) {
        return cloudVoiceLabel(engine, voiceNameOf(id));
    }
    const info = view?.voices.find((voice) => voice.id === id);
    return info === undefined ? voiceNameOf(id) : localVoiceLabel(info);
};

/** What speaks a language nobody picked a voice for. */
export const defaultVoiceFor = (view: VoicesView, cloud: CloudVoice | undefined, language: string): VoiceId | undefined =>
    cloud !== undefined && providerSpeaks(view, cloud, language)
        ? cloudVoiceId(cloud.provider, cloud.voice)
        : (view.defaults[language] ?? view.defaults[FALLBACK_LANGUAGE]);

// The default's own name inside "Default (…)": the provider by name alone, so the option does not nest brackets.
const defaultLabel = (view: VoicesView, cloud: CloudVoice | undefined, language: string): string => {
    const fallback = defaultVoiceFor(view, cloud, language);
    if (fallback === undefined) {
        return ``;
    }
    const engine = voiceEngineOf(fallback);
    if (isCloudVoiceEngine(engine) && voiceNameOf(fallback) === `default`) {
        return PROVIDER_NAMES[engine];
    }
    return voiceLabel(fallback, view);
};

/**
 * The voices a language can be given, in the order the card offers them: the default (which writes no pick), the
 * provider's default and the provider voice the settings name, where the provider speaks the language, then this
 * sandbox's own. A pick none of those covers (a voice since dropped) is kept as an option, so the select still says it.
 */
export const voiceChoices = (view: VoicesView, settings: VoiceSettings, language: string): Choice[] => {
    const choices: Choice[] = [{ value: ``, label: t(`sandbox.agentVoice.defaultVoice`, { voice: defaultLabel(view, settings.cloud, language) }) }];
    const cloud = settings.cloud;
    if (cloud !== undefined && providerSpeaks(view, cloud, language)) {
        choices.push({ value: `${cloud.provider}/default`, label: cloudVoiceLabel(cloud.provider, ``) });
        const own = cloud.voice === `` ? undefined : cloudVoiceId(cloud.provider, cloud.voice);
        if (own !== undefined) {
            choices.push({ value: own, label: cloudVoiceLabel(cloud.provider, cloud.voice) });
        }
    }
    for (const info of view.voices) {
        if (info.languages.includes(language)) {
            choices.push({ value: info.id, label: localChoiceLabel(info) });
        }
    }
    const picked = settings.voices[language];
    if (picked !== undefined && !choices.some((choice) => choice.value === picked)) {
        choices.push({ value: picked, label: voiceLabel(picked, view) });
    }
    return choices;
};

/** One language the owner picked a voice for, as the list under the picker shows it. */
export interface PickedVoice {
    readonly language: string;
    readonly languageLabel: string;
    readonly voice: VoiceId;
    readonly voiceLabel: string;
}

export const pickedVoices = (voices: Picks, view: VoicesView | undefined, locale: string): PickedVoice[] =>
    Object.entries(voices)
        .map(([language, voice]) => ({ language, languageLabel: languageName(language, locale), voice, voiceLabel: voiceLabel(voice, view) }))
        .toSorted((a, b) => a.languageLabel.localeCompare(b.languageLabel, locale));

/** The picks with this language's set to `voice`, or removed when `voice` is empty (the default). */
export const withVoiceFor = (voices: Picks, language: string, voice: string): Picks => {
    const kept = Object.fromEntries(Object.entries(voices).filter(([held]) => held !== language));
    if (voice === ``) {
        return kept;
    }
    // A value the select did not offer is not a voice; the picks stay as they were.
    if (!VOICE_ID.test(voice)) {
        return { ...voices };
    }
    kept[language] = voice;
    return kept;
};

// A pick naming a provider that is no longer the connected one would be passed over by the daemon in silence, and go
// on being listed here as if it spoke; dropped with the provider instead.
const keptFor = (voices: Picks, provider: CloudVoiceProvider | undefined): Picks =>
    Object.fromEntries(
        Object.entries(voices).filter(([, voice]) => {
            const engine = voiceEngineOf(voice);
            return !isCloudVoiceEngine(engine) || engine === provider;
        }),
    );

/** The settings with `provider` connected in place of any other, or with none. */
export const withProvider = (settings: VoiceSettings, provider: CloudVoiceProvider | undefined): VoiceSettings => {
    if (provider === settings.cloud?.provider) {
        return settings;
    }
    const { cloud: _replaced, ...rest } = settings;
    const voices = keptFor(settings.voices, provider);
    if (provider === undefined) {
        return { ...rest, voices };
    }
    // Model and voice ids are each provider's own, so a new provider starts on its defaults.
    return { ...rest, voices, cloud: { provider, secret: PROVIDER_SECRETS[provider], model: ``, voice: `` } };
};

/** The settings with one of the provider's fields changed; a secret is a name, so an emptied one is not written. */
export const withCloudField = (settings: VoiceSettings, field: `secret` | `model` | `voice`, value: string): VoiceSettings => {
    const cloud = settings.cloud;
    const trimmed = value.trim();
    if (cloud === undefined || cloud[field] === trimmed || (field === `secret` && trimmed === ``)) {
        return settings;
    }
    return { ...settings, cloud: { ...cloud, [field]: trimmed } };
};

// What a preview says, in the language it previews, since a voice reading another language's words is no preview of
// it. Each says what the voice is for; a language not written here hears the English one.
const SAMPLES = new Map([
    [`en`, `Hello. This is how I sound when I answer you out loud.`],
    [`pl`, `Cześć. Tak brzmię, kiedy odpowiadam ci na głos.`],
    [`de`, `Hallo. So klinge ich, wenn ich dir laut antworte.`],
    [`es`, `Hola. Así sueno cuando te respondo en voz alta.`],
    [`fr`, `Bonjour. Voici ma voix quand je te réponds à voix haute.`],
    [`it`, `Ciao. Ecco come suono quando ti rispondo ad alta voce.`],
    [`pt`, `Olá. É assim que eu soo quando te respondo em voz alta.`],
    [`nl`, `Hallo. Zo klink ik als ik je hardop antwoord.`],
    [`cs`, `Ahoj. Takhle zním, když ti odpovídám nahlas.`],
    [`sk`, `Ahoj. Takto znie môj hlas, keď ti odpovedám nahlas.`],
    [`sv`, `Hej. Så här låter jag när jag svarar dig högt.`],
    [`da`, `Hej. Sådan lyder jeg, når jeg svarer dig højt.`],
    [`no`, `Hei. Slik høres jeg ut når jeg svarer deg høyt.`],
    [`fi`, `Hei. Tältä kuulostan, kun vastaan sinulle ääneen.`],
    [`ru`, `Привет. Так звучит мой голос, когда я отвечаю тебе вслух.`],
    [`uk`, `Привіт. Ось так звучить мій голос, коли я відповідаю тобі вголос.`],
    [`hu`, `Szia. Így hangzom, amikor hangosan válaszolok neked.`],
    [`ro`, `Salut. Așa sun când îți răspund cu voce tare.`],
    [`tr`, `Merhaba. Sana sesli yanıt verdiğimde sesim böyle duyulur.`],
    [`el`, `Γεια σου. Έτσι ακούγομαι όταν σου απαντώ φωναχτά.`],
    [`ca`, `Hola. Així sono quan et responc en veu alta.`],
    [`id`, `Halo. Beginilah suaraku saat aku menjawabmu dengan lantang.`],
    [`vi`, `Xin chào. Đây là giọng của tôi khi tôi trả lời bạn thành tiếng.`],
    [`ar`, `مرحبًا. هكذا يبدو صوتي عندما أجيبك بصوت عالٍ.`],
    [`hi`, `नमस्ते। बोलकर जवाब देते समय मेरी आवाज़ ऐसी सुनाई देती है।`],
    [`ja`, `こんにちは。声で答えるときは、こんなふうに聞こえます。`],
    [`zh`, `你好。我大声回答你的时候，听起来就是这样。`],
    [`ko`, `안녕하세요. 소리 내어 대답할 때 제 목소리는 이렇게 들려요.`],
]);

export const sampleSentence = (language: string): string => SAMPLES.get(language) ?? SAMPLES.get(FALLBACK_LANGUAGE) ?? ``;
