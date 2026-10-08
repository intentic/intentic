// The browser's own on-device recognizer as a bridge for the minute a sandbox spends fetching its speech model: on a
// browser that can hear the language without sending audio anywhere (Chrome's Web Speech `processLocally`), the words
// appear while the model downloads, and the sandbox takes over from the next phrase once it is ready. Never a cloud
// recognizer: a browser that cannot promise on-device recognition, or has no language pack for this language already
// installed, gets no bridge at all, and its phrases simply wait for the sandbox.

export interface BrowserSpeechEvents {
    readonly partial: (text: string) => void;
    readonly final: (text: string) => void;
    /** It stopped on its own (an error, or the browser ending the session): the sandbox hears from here on. */
    readonly ended: () => void;
}

export interface BrowserSpeech {
    /** Stop listening; a phrase it already heard may still arrive as a final. */
    readonly stop: () => void;
}

// The slice of the Web Speech API this reads; typed here since lib.dom carries neither the on-device additions nor,
// in every TypeScript version, the recognizer itself.
interface RecognitionResult {
    readonly isFinal: boolean;
    readonly 0?: { readonly transcript: string };
}
interface RecognitionEvent {
    readonly resultIndex: number;
    readonly results: ArrayLike<RecognitionResult>;
}
interface Recognition extends EventTarget {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    processLocally?: boolean;
    options?: { langs: string[]; processLocally: boolean };
    start(): void;
    stop(): void;
}
interface RecognitionClass {
    new (): Recognition;
    readonly prototype: object;
    readonly available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
}

/** The page's recognizer class, if it has one that can be held to on-device processing. */
const onDeviceRecognizer = (page: object): RecognitionClass | undefined => {
    const scope = page as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
    const recognizer = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
    if (recognizer === undefined || typeof recognizer.available !== `function`) {
        return undefined;
    }
    // The switch itself must exist: a browser that only has the availability check could still send audio away.
    return `processLocally` in recognizer.prototype || `options` in recognizer.prototype ? recognizer : undefined;
};

/**
 * A starter for the bridge when this browser can hear `lang` on the device right now (its language pack installed),
 * or undefined. Asked once per press; never installs a pack, which would be a download the person did not ask for.
 */
export const browserSpeechFor = async (
    lang: string,
    page: object = globalThis,
): Promise<((events: BrowserSpeechEvents) => BrowserSpeech) | undefined> => {
    const recognizer = onDeviceRecognizer(page);
    if (recognizer?.available === undefined) {
        return undefined;
    }
    const options = { langs: [lang], processLocally: true };
    const status = await recognizer.available(options).catch(() => `unavailable`);
    if (status !== `available`) {
        return undefined;
    }
    return (events) => {
        const recognition = new recognizer();
        recognition.lang = lang;
        recognition.continuous = true;
        recognition.interimResults = true;
        // Both spellings: Chrome shipped the attribute, the explainer the options bag. Either holds it on the device.
        recognition.processLocally = true;
        recognition.options = options;
        let stopped = false;
        recognition.addEventListener(`result`, (raw) => {
            const event = raw as unknown as RecognitionEvent;
            let interim = ``;
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const result = event.results[index];
                const text = result?.[0]?.transcript.trim() ?? ``;
                if (text === ``) {
                    continue;
                }
                if (result?.isFinal === true) {
                    events.final(text);
                } else {
                    interim = interim === `` ? text : `${interim} ${text}`;
                }
            }
            if (interim !== ``) {
                events.partial(interim);
            }
        });
        recognition.addEventListener(`error`, () => {
            stopped = true;
        });
        recognition.addEventListener(`end`, () => {
            stopped = true;
            events.ended();
        });
        try {
            recognition.start();
        } catch {
            queueMicrotask(events.ended);
        }
        return {
            stop: () => {
                if (!stopped) {
                    stopped = true;
                    recognition.stop();
                }
            },
        };
    };
};
