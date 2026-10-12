import { setFormatLocale } from "@intentic/ui/format";
import { VoiceSettingsSchema, type VoicesView } from "@intentic/sandbox-contract";
import {
    defaultVoiceFor,
    initialLanguage,
    languageChoices,
    pickedVoices,
    sampleSentence,
    speedChoices,
    voiceChoices,
    withCloudField,
    withProvider,
    withVoiceFor,
} from "./agentVoice";

// The card's choices are the daemon's rule for who speaks a language, read the other way round: these hold the two
// to the same answer for the cases an owner meets (nothing picked, a provider connected, a pick for another provider).

const VIEW: VoicesView = {
    voices: [
        { id: `kokoro/af_heart`, label: `Heart`, languages: [`en`], accent: `US`, gender: `female`, model: `kokoro`, bytes: 349_906_910, installed: true },
        { id: `kokoro/bm_george`, label: `George`, languages: [`en`], accent: `GB`, gender: `male`, model: `kokoro`, bytes: 349_906_910, installed: true },
        { id: `piper/pl_PL-gosia-medium`, label: `Gosia`, languages: [`pl`], accent: `PL`, gender: `female`, model: `gosia`, bytes: 67_211_182, installed: false },
        { id: `piper/pl_PL-darkman-medium`, label: `Darkman`, languages: [`pl`], accent: `PL`, gender: `male`, model: `darkman`, bytes: 67_215_635, installed: false },
    ],
    defaults: { en: `kokoro/af_heart`, pl: `piper/pl_PL-gosia-medium` },
    provisioned: true,
};

const SETTINGS = VoiceSettingsSchema.parse({});
const ELEVEN = withProvider(SETTINGS, `elevenlabs`);
const VIEW_ELEVEN: VoicesView = { ...VIEW, cloud: { provider: `elevenlabs`, ready: true, languages: [`en`, `pl`, `ko`] } };

describe(`the languages offered`, () => {
    test(`are this sandbox's, named in the reader's language and sorted by that name`, () => {
        expect(languageChoices(VIEW, undefined, `en`)).toEqual([
            { value: `en`, label: `English` },
            { value: `pl`, label: `Polish` },
        ]);
        expect(languageChoices(VIEW, undefined, `pl`).map((choice) => choice.label)).toEqual([`Angielski`, `Polski`]);
    });

    test(`take in what the connected provider speaks, once the read agrees on the provider`, () => {
        expect(languageChoices(VIEW_ELEVEN, ELEVEN.cloud, `en`).map((choice) => choice.value)).toEqual([`en`, `ko`, `pl`]);
        expect(languageChoices(VIEW_ELEVEN, withProvider(SETTINGS, `cartesia`).cloud, `en`).map((choice) => choice.value)).toEqual([`en`, `pl`]);
    });

    test(`open on the reader's own language where something speaks it, English otherwise`, () => {
        const choices = languageChoices(VIEW, undefined, `en`);
        expect(initialLanguage(choices, `pl-PL`)).toBe(`pl`);
        expect(initialLanguage(choices, `de`)).toBe(`en`);
    });
});

describe(`the voices offered for a language`, () => {
    test(`start with the default, then this sandbox's voices, saying what a missing model downloads`, () => {
        expect(voiceChoices(VIEW, SETTINGS, `pl`)).toEqual([
            { value: ``, label: `Default (Gosia · PL · female)` },
            { value: `piper/pl_PL-gosia-medium`, label: `Gosia · PL · female (downloads 67 MB)` },
            { value: `piper/pl_PL-darkman-medium`, label: `Darkman · PL · male (downloads 67 MB)` },
        ]);
        expect(voiceChoices(VIEW, SETTINGS, `en`).map((choice) => choice.label)).toEqual([
            `Default (Heart · US · female)`,
            `Heart · US · female`,
            `George · GB · male`,
        ]);
    });

    test(`put the provider first where it speaks the language, its own default and the voice the settings name`, () => {
        const named = withCloudField(ELEVEN, `voice`, `21m00Tcm4TlvDq8ikWAM`);
        expect(voiceChoices(VIEW_ELEVEN, ELEVEN, `pl`).slice(0, 2)).toEqual([
            { value: ``, label: `Default (ElevenLabs)` },
            { value: `elevenlabs/default`, label: `ElevenLabs (its default voice)` },
        ]);
        expect(voiceChoices(VIEW_ELEVEN, named, `pl`).slice(0, 3)).toEqual([
            { value: ``, label: `Default (ElevenLabs · 21m00Tcm4TlvDq8ikWAM)` },
            { value: `elevenlabs/default`, label: `ElevenLabs (its default voice)` },
            { value: `elevenlabs/21m00Tcm4TlvDq8ikWAM`, label: `ElevenLabs · 21m00Tcm4TlvDq8ikWAM` },
        ]);
    });

    test(`keep a pick nothing else offers, so the select still says what is set`, () => {
        const picked = { ...SETTINGS, voices: { pl: `piper/pl_PL-someone-medium` } };
        expect(voiceChoices(VIEW, picked, `pl`).at(-1)).toEqual({ value: `piper/pl_PL-someone-medium`, label: `pl_PL-someone-medium` });
    });

    test(`name the same default the daemon speaks with`, () => {
        expect(defaultVoiceFor(VIEW, undefined, `pl`)).toBe(`piper/pl_PL-gosia-medium`);
        expect(defaultVoiceFor(VIEW, undefined, `ko`)).toBe(`kokoro/af_heart`);
        expect(defaultVoiceFor(VIEW_ELEVEN, ELEVEN.cloud, `pl`)).toBe(`elevenlabs/default`);
    });
});

describe(`a pick`, () => {
    test(`is written for its language, and the default removes it`, () => {
        const picked = withVoiceFor({}, `pl`, `piper/pl_PL-darkman-medium`);
        expect(picked).toEqual({ pl: `piper/pl_PL-darkman-medium` });
        expect(withVoiceFor(picked, `pl`, ``)).toEqual({});
        expect(withVoiceFor(picked, `en`, `not a voice`)).toEqual(picked);
    });

    test(`is listed by language name, with its voice in words`, () => {
        expect(pickedVoices({ pl: `piper/pl_PL-darkman-medium`, en: `elevenlabs/default` }, VIEW, `en`)).toEqual([
            { language: `en`, languageLabel: `English`, voice: `elevenlabs/default`, voiceLabel: `ElevenLabs (its default voice)` },
            { language: `pl`, languageLabel: `Polish`, voice: `piper/pl_PL-darkman-medium`, voiceLabel: `Darkman · PL · male` },
        ]);
    });
});

describe(`the provider`, () => {
    test(`starts on the key name its documentation gives, with its own defaults`, () => {
        expect(ELEVEN.cloud).toEqual({ provider: `elevenlabs`, secret: `ELEVENLABS_API_KEY`, model: ``, voice: `` });
    });

    test(`takes the picks of its voices with it when it changes or goes, and leaves this sandbox's`, () => {
        const picked = { ...ELEVEN, voices: { en: `elevenlabs/default`, pl: `piper/pl_PL-darkman-medium` } };
        expect(withProvider(picked, `deepgram`).voices).toEqual({ pl: `piper/pl_PL-darkman-medium` });
        const none = withProvider(picked, undefined);
        expect(none.voices).toEqual({ pl: `piper/pl_PL-darkman-medium` });
        expect(`cloud` in none).toBe(false);
        expect(withProvider(picked, `elevenlabs`)).toBe(picked);
    });

    test(`never stores an empty secret name`, () => {
        expect(withCloudField(ELEVEN, `secret`, `  `)).toBe(ELEVEN);
        expect(withCloudField(ELEVEN, `secret`, ` MY_KEY `).cloud?.secret).toBe(`MY_KEY`);
        expect(withCloudField(ELEVEN, `model`, ``)).toBe(ELEVEN);
        expect(withCloudField(SETTINGS, `model`, `eleven_flash_v2_5`)).toBe(SETTINGS);
    });
});

test(`speeds are written the reader's way, and a speed set elsewhere is kept among them`, () => {
    setFormatLocale(`pl`);
    expect(speedChoices(1).map((choice) => choice.label)).toEqual([`0,8×`, `0,9×`, `1×`, `1,1×`, `1,25×`, `1,5×`]);
    setFormatLocale(`en`);
    expect(speedChoices(1.3).map((choice) => choice.value)).toEqual([`0.8`, `0.9`, `1`, `1.1`, `1.25`, `1.3`, `1.5`]);
});

test(`a preview speaks the language it previews`, () => {
    expect(sampleSentence(`pl`)).toMatch(/głos/);
    expect(sampleSentence(`sw`)).toBe(sampleSentence(`en`));
});
