import type { VoiceId, VoiceInfo } from "@intentic/sandbox-contract/schemas/voice";

// The voices this sandbox speaks with on its own CPU, and the models they live in: k2-fsa's sherpa-onnx exports, each
// one archive on the project's `tts-models` release, pinned by size and sha256 and fetched the first time a voice of it
// is asked to speak (voice-model-store.ts). Kokoro speaks the eight languages it was trained on with one model and 54
// voices; Piper fills in the rest with one small model per voice. Both run through the sherpa-onnx runtime dictation
// already loads, so speaking adds no native dependency.

export type LocalVoiceKind = "kokoro" | "piper";

export interface LocalVoiceModel {
    // The archive's own name, less `.tar.bz2`: also the directory it unpacks to and is cached under.
    readonly id: string;
    readonly kind: LocalVoiceKind;
    readonly bytes: number;
    readonly sha256: string;
    // Whose model it is and under what licence: written beside the weights.
    readonly attribution: string;
}

export interface LocalVoice {
    readonly id: VoiceId;
    readonly model: LocalVoiceModel;
    // The speaker inside a multi-voice model (Kokoro's table); 0 for a one-voice model.
    readonly sid: number;
    readonly label: string;
    readonly language: string;
    readonly accent?: string;
    readonly gender?: "female" | "male";
    // What Kokoro's phonemizer is told the text is, for a voice whose language its English lexicon does not cover.
    readonly kokoroLang?: string;
}

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";
export const voiceModelUrl = (model: LocalVoiceModel): string => `${RELEASE}/${model.id}.tar.bz2`;

// Full precision rather than the int8 export: on an x86 sandbox it is the faster of the two (0.4x real time on two
// busy cores against 0.64x, 2026-10-12), which is what decides whether speech keeps ahead of playback.
export const KOKORO_MODEL: LocalVoiceModel = {
    id: "kokoro-multi-lang-v1_0",
    kind: "kokoro",
    bytes: 349_906_910,
    sha256: "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298",
    attribution: "Kokoro-82M v1.0 by hexgrad (https://huggingface.co/hexgrad/Kokoro-82M), Apache-2.0, exported to ONNX by k2-fsa/sherpa-onnx.",
};

// The model's own speaker table, in its order (its `speaker_names` metadata): the index is the speaker id. Each name's
// first letter is its language and accent, its second the voice's gender.
const KOKORO_SPEAKERS =
    "af_alloy,af_aoede,af_bella,af_heart,af_jessica,af_kore,af_nicole,af_nova,af_river,af_sarah,af_sky,am_adam,am_echo,am_eric,am_fenrir,am_liam,am_michael,am_onyx,am_puck,am_santa,bf_alice,bf_emma,bf_isabella,bf_lily,bm_daniel,bm_fable,bm_george,bm_lewis,ef_dora,em_alex,ff_siwis,hf_alpha,hf_beta,hm_omega,hm_psi,if_sara,im_nicola,jf_alpha,jf_gongitsune,jf_nezumi,jf_tebukuro,jm_kumo,pf_dora,pm_alex,pm_santa,zf_xiaobei,zf_xiaoni,zf_xiaoxiao,zf_xiaoyi,zm_yunjian,zm_yunxi,zm_yunxia,zm_yunyang,em_santa".split(
        ",",
    );

// Kokoro's language letters. English goes through the model's own lexicon, so it names no phonemizer language; every
// other one must, or Spanish is read with English rules (heard back as "Naisio Decision Ajoro").
interface KokoroLanguage {
    readonly language: string;
    readonly accent?: string;
    readonly kokoroLang?: string;
}
const KOKORO_LANGUAGES = {
    a: { language: "en", accent: "US" },
    b: { language: "en", accent: "GB" },
    e: { language: "es", kokoroLang: "es" },
    f: { language: "fr", kokoroLang: "fr" },
    h: { language: "hi", kokoroLang: "hi" },
    i: { language: "it", kokoroLang: "it" },
    j: { language: "ja", kokoroLang: "ja" },
    p: { language: "pt", accent: "BR", kokoroLang: "pt-br" },
    z: { language: "zh", kokoroLang: "zh" },
} satisfies Record<string, KokoroLanguage>;
type KokoroLetter = keyof typeof KOKORO_LANGUAGES;

const capitalized = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

const kokoroVoices: readonly LocalVoice[] = KOKORO_SPEAKERS.map((speaker, sid) => {
    // SAFETY: every name in the model's table starts with one of the nine letters KOKORO_LANGUAGES spells out.
    const { language, ...spoken }: KokoroLanguage = KOKORO_LANGUAGES[speaker.charAt(0) as KokoroLetter];
    return {
        id: `kokoro/${speaker}`,
        model: KOKORO_MODEL,
        sid,
        label: capitalized(speaker.slice(3)),
        language,
        ...spoken,
        gender: speaker.charAt(1) === "f" ? "female" : "male",
    };
});

const piper = (name: string, label: string, language: string, gender: "female" | "male" | undefined, bytes: number, sha256: string): LocalVoice => {
    const voice: LocalVoice = {
        id: `piper/${name}`,
        model: {
            id: `vits-piper-${name}`,
            kind: "piper",
            bytes,
            sha256,
            attribution: `Piper voice ${name} (https://huggingface.co/rhasspy/piper-voices), under the licence in its MODEL_CARD, exported to ONNX by k2-fsa/sherpa-onnx.`,
        },
        sid: 0,
        label,
        language,
        accent: name.slice(3, 5),
    };
    return gender === undefined ? voice : { ...voice, gender };
};

// One or two medium-quality voices for each language Kokoro does not speak, from the release's 185 (2026-10-12): the
// rest can be pinned here the same way, size and digest copied from the release's own asset list.
const piperVoices: readonly LocalVoice[] = [
    piper("pl_PL-gosia-medium", "Gosia", "pl", "female", 67211182, "75bd34dcbdc4dd98d763954756b4b34b4208100497c836381542e4d73dcefa9c"),
    piper("pl_PL-darkman-medium", "Darkman", "pl", "male", 67215635, "444727aa46eb6db645a2bc88fe73868e4bd7596b7f56ca39fad5ef53c41210d4"),
    piper("de_DE-thorsten-medium", "Thorsten", "de", "male", 67214254, "50487d9c95fdf2191f31d2588569381063ba1591dcd4c7d4bdd30f12b2191714"),
    piper("de_DE-kerstin-low", "Kerstin", "de", "female", 67107768, "4bfe121d5f690a3b87acecd7ae1e70b48f4589ce6ae9f45a1809e6eb19fad97b"),
    piper("nl_NL-ronnie-medium", "Ronnie", "nl", "male", 67194164, "d2cc688abf46054eba1d47b3b1406c742ccf66732cd47998a3ee727c1b96c09f"),
    piper("nl_BE-nathalie-medium", "Nathalie", "nl", "female", 67226472, "c7484313abea395243e872196bc75181c07aad8120b8a61e0f6f4b3863b6a7c8"),
    piper("cs_CZ-jirka-medium", "Jirka", "cs", "male", 67212775, "321aafd83dd89b3d5b2c36c5898e0710d4f472f3c191cb7f73901a89b7f8539f"),
    piper("sk_SK-lili-medium", "Lili", "sk", "female", 67183092, "a00dfbca5d34733862a59d9e309f4e94a92fccc9337c2b124de9a241b604fc0d"),
    piper("uk_UA-ukrainian_tts-medium", "Ukrainian TTS", "uk", undefined, 80355083, "92be6ff21ebb1cbcc0c71121a6437db8d060cee5785287aaa6a19a2548f59c03"),
    piper("ru_RU-irina-medium", "Irina", "ru", "female", 67153308, "1fc0f54e5e084fe287c07909f2f6e0ba6d857864cf800e3ab80286a4e8233008"),
    piper("ru_RU-dmitri-medium", "Dmitri", "ru", "male", 67188551, "c86d0803737de13d441923ff3b3f309482fab8d7af3ec85949942809eb9a3660"),
    piper("sv_SE-lisa-medium", "Lisa", "sv", "female", 67223955, "78b5f6808e513d545d9284a015075ef31f09623e6c08d6186a29a1997aa577d7"),
    piper("da_DK-talesyntese-medium", "Talesyntese", "da", "male", 67185257, "f2e2cbcdb2b21e76f93635b35105d07b37997ace434d7289d04b689a97c19bd0"),
    piper("no_NO-talesyntese-medium", "Talesyntese", "no", "male", 67194829, "dcb7c36b7222e290cca1fd4cdecb474e7fd651dc5b0d3d42c33d416a8e62018b"),
    piper("fi_FI-harri-medium", "Harri", "fi", "male", 67205198, "a7fd608e73983c366a5e0bcd13382e6529a6749f67efc406b5a7f9021e3a8b1d"),
    piper("el_GR-rapunzelina-low", "Rapunzelina", "el", "female", 67105521, "bb868070a9ba0d7220b3d7c9291a998c2f60accdb73525bd63b8751b86dd4839"),
    piper("hu_HU-anna-medium", "Anna", "hu", "female", 67167701, "c67b13e57b71eca19098fe499afc35ebce8f63a0b524017c786af2025821216a"),
    piper("ro_RO-mihai-medium", "Mihai", "ro", "male", 67182137, "cfbee3cdc25cf063339f69e189f4d93cc3be6610d267567537323ced3cf87f4d"),
    piper("tr_TR-dfki-medium", "DFKI", "tr", "male", 67201221, "b63babaefcdd63202c7079aba25b72a2013825ad5895e2aeff03d1ae5a5b3bbf"),
    piper("vi_VN-vais1000-medium", "VAIS1000", "vi", "female", 67154040, "fa1367710767d36ed5cf13b4a449e20c35ffd12791c2e47c2e64142bfa55551a"),
    piper("ar_JO-kareem-medium", "Kareem", "ar", "male", 67177830, "9ebbcea30e0fbd588f7b2cb45ee897d6aeb1bf5791cbc037a7b5a3f641e3dbce"),
    piper("fa_IR-gyro-medium", "Gyro", "fa", "male", 67183308, "75dc485f0c0528b1b07800464e5c72f4229339919525b3f634aa89690988d30e"),
    piper("ca_ES-upc_ona-medium", "Ona", "ca", "female", 67223188, "b6c50f22e13cfc72ce51c496d22b987adf6704047f6d342968197b4b0b3127a5"),
    piper("cy_GB-gwryw_gogleddol-medium", "Gwryw Gogleddol", "cy", "male", 67230234, "f31f90afc4f28e9a768309f0b1c87272ef178936b32dd181aa1aa3a0eeddd187"),
    piper("is_IS-ugla-medium", "Ugla", "is", "female", 67376655, "2d2295b13746758620ef02ee35294ff1096d94fd01cb055c53f70de17a222519"),
    piper("ka_GE-natia-medium", "Natia", "ka", "female", 67209457, "18e34c601f4be13e5132ec772e2cbcfa47ca6a4aaaf995dd5baefe014f5a0256"),
    piper("lb_LU-marylux-medium", "Marylux", "lb", "female", 67184319, "f11117fc121db0d5c4dc46e07eac7b1d8ea719b04f0b381836a23050310ea5a4"),
    piper("lv_LV-aivars-medium", "Aivars", "lv", "male", 67196173, "a0df58c9924761e201ef75d82473b90bde32c5372267e9b4c628fdd267cf2508"),
    piper("sl_SI-artur-medium", "Artur", "sl", "male", 67025668, "df805f31c4513864edebf7e287cf0b54d72788fc661ed73f88dc4e5aabc5efd5"),
    piper("sr_RS-serbski_institut-medium", "Serbski Institut", "sr", "male", 80298557, "b8c100e5ff885d11ff96ad92a953f4b82e1cd649f9ac60a77ae4553d37507b2b"),
    piper("sw_CD-lanfrica-medium", "Lanfrica", "sw", "male", 67217230, "93196704a0ae0c984806059480775d69dcc2419d0d545cddd0903d244dc66a72"),
    piper("id_ID-news_tts-medium", "News TTS", "id", "female", 67243848, "634b0169fe41c368e9fafe128f30647f9e0301e852ce503cd78146db524f1f12"),
    piper("ne_NP-chitwan-medium", "Chitwan", "ne", "male", 67213467, "65fa157c090844bbe5b38c1c3e4321535f569fdbb526c08aaa2ad22c09d51279"),
    piper("eu_ES-maider-medium", "Maider", "eu", "female", 67247291, "60493b81a7f117ea96b6efc841d7465c1d4107ea72ef553ff91f92f72fbd95c1"),
    piper("ml_IN-meera-medium", "Meera", "ml", "female", 67195010, "c8d870441e60870b7e8781c26eb22104aff51587b63bee94aba5e5f6c9fbb71f"),
    piper("sq_AL-edon-medium", "Edon", "sq", "male", 67191820, "2d7a3b3647a499ad40a28662edd5ff50eb8594ad7ace94a5d3525e280212bf99"),
    piper("ur_PK-fasih-medium", "Fasih", "ur", "male", 67227718, "de64e03109f3c896b7cf910db6d9ffd2703e3d665580d9a19bedbf3e0760d0e4"),
];

export const LOCAL_VOICES: readonly LocalVoice[] = [...kokoroVoices, ...piperVoices];

const BY_ID = new Map(LOCAL_VOICES.map((voice) => [voice.id, voice]));
export const localVoice = (id: string): LocalVoice | undefined => BY_ID.get(id);

// What speaks a language nobody chose a voice for: Kokoro's best-rated voice where it speaks the language, the first
// pinned Piper voice elsewhere.
const KOKORO_DEFAULTS = {
    en: "af_heart",
    es: "ef_dora",
    fr: "ff_siwis",
    hi: "hf_alpha",
    it: "if_sara",
    ja: "jf_alpha",
    pt: "pf_dora",
    zh: "zf_xiaobei",
} satisfies Record<string, (typeof KOKORO_SPEAKERS)[number]>;

export const LOCAL_DEFAULTS: Readonly<Record<string, VoiceId>> = Object.fromEntries([
    ...Object.entries(KOKORO_DEFAULTS).map(([language, speaker]) => [language, `kokoro/${speaker}`]),
    ...piperVoices.filter((voice, index) => piperVoices.findIndex((other) => other.language === voice.language) === index).map((voice) => [voice.language, voice.id]),
]);

// A language no local voice speaks is said in English, which is at least a voice saying something.
export const FALLBACK_LANGUAGE = "en";

export const localDefault = (language: string): LocalVoice => localVoice(LOCAL_DEFAULTS[language] ?? LOCAL_DEFAULTS[FALLBACK_LANGUAGE]!)!;

export const voiceInfo = (voice: LocalVoice, installed: boolean | undefined): VoiceInfo => {
    const info: VoiceInfo = { id: voice.id, label: voice.label, languages: [voice.language], model: voice.model.id, bytes: voice.model.bytes };
    if (voice.accent !== undefined) {
        info.accent = voice.accent;
    }
    if (voice.gender !== undefined) {
        info.gender = voice.gender;
    }
    if (installed !== undefined) {
        info.installed = installed;
    }
    return info;
};
