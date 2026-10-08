import { browserSpeechFor } from "./browserSpeech";

// Pins the bridge's one promise: it only ever runs on a recognizer held to the device, with the language already
// installed, and never asks the browser to download or to send audio anywhere.

interface Started {
    lang?: string;
    processLocally?: boolean;
    options?: { langs: string[]; processLocally: boolean };
    continuous?: boolean;
    interimResults?: boolean;
}

// A page whose recognizer answers `available` with `status` and records each one it starts.
const pageWith = (status: string, options: { readonly onDeviceSwitch?: boolean } = {}) => {
    const started: Started[] = [];
    const instances: FakeRecognition[] = [];
    const asked: unknown[] = [];
    class FakeRecognition extends EventTarget {
        lang = ``;
        continuous = false;
        interimResults = false;
        start(): void {
            started.push({ ...this });
            instances.push(this);
        }
        stop(): void {
            this.dispatchEvent(new Event(`end`));
        }
        results(resultIndex: number, results: unknown[]): void {
            this.dispatchEvent(Object.assign(new Event(`result`), { resultIndex, results }));
        }
        static available = async (asking: unknown): Promise<string> => {
            asked.push(asking);
            return status;
        };
        static install = (): never => {
            throw new Error(`the bridge must never install a language pack`);
        };
    }
    if (options.onDeviceSwitch !== false) {
        Object.defineProperty(FakeRecognition.prototype, `processLocally`, { value: false, writable: true });
    }
    return { page: { SpeechRecognition: FakeRecognition }, started, instances, asked };
};

const result = (transcript: string, isFinal: boolean) => Object.assign([{ transcript }], { isFinal });

test(`a browser with the language installed on the device bridges, held to the device`, async () => {
    const browser = pageWith(`available`);
    const start = await browserSpeechFor(`pl-PL`, browser.page);
    expect(browser.asked).toEqual([{ langs: [`pl-PL`], processLocally: true }]);
    expect(start).toEqual(expect.any(Function));
    const heard: string[] = [];
    const bridge = start!({ partial: (text) => heard.push(`~${text}`), final: (text) => heard.push(text), ended: () => heard.push(`ended`) });
    expect(browser.started).toHaveLength(1);
    expect(browser.started[0]).toMatchObject({
        lang: `pl-PL`,
        continuous: true,
        interimResults: true,
        processLocally: true,
        options: { langs: [`pl-PL`], processLocally: true },
    });
    const recognition = browser.instances[0]!;
    recognition.results(0, [result(`dzień`, false)]);
    recognition.results(0, [result(`Dzień dobry`, true), result(` co`, false)]);
    bridge.stop();
    expect(heard).toEqual([`~dzień`, `Dzień dobry`, `~co`, `ended`]);
});

test(`a language that would need a download, or a recognizer that could leave the device, is no bridge`, async () => {
    for (const status of [`downloadable`, `downloading`, `unavailable`]) {
        expect(await browserSpeechFor(`pl-PL`, pageWith(status).page)).toBeUndefined();
    }
    expect(await browserSpeechFor(`pl-PL`, pageWith(`available`, { onDeviceSwitch: false }).page)).toBeUndefined();
    // No availability check at all is a browser from before on-device recognition: it would use its cloud service.
    expect(await browserSpeechFor(`pl-PL`, { SpeechRecognition: EventTarget })).toBeUndefined();
    expect(await browserSpeechFor(`pl-PL`, {})).toBeUndefined();
});
