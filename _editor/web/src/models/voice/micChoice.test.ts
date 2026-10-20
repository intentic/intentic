import { chooseMic, chosenMic, type ListedDevice, listMics, openMicWith } from "./micChoice";

// Pins how the picked microphone is opened: the browser's own when none is picked, the picked one exactly otherwise,
// the browser's again when the picked one is not there (and the pick kept), and the browser's list without its aliases.

const CLEANUP = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

// A browser whose getUserMedia answers `stream`, or refuses what `refuse` names; every ask is recorded.
const browser = (refuse?: (asked: MediaStreamConstraints) => Error | undefined) => {
    const asked: MediaStreamConstraints[] = [];
    const open = async (constraints: MediaStreamConstraints): Promise<string> => {
        asked.push(constraints);
        const refused = refuse?.(constraints);
        if (refused !== undefined) {
            throw refused;
        }
        return `stream`;
    };
    return { open, asked };
};

const failure = (name: string): Error => Object.assign(new Error(name), { name });
const picksDevice = (asked: MediaStreamConstraints): boolean => JSON.stringify(asked).includes(`deviceId`);

describe(`openMicWith`, () => {
    test(`nothing picked leaves the choice to the browser, with its cleanup on`, async () => {
        const { open, asked } = browser();
        await expect(openMicWith(open, undefined)).resolves.toBe(`stream`);
        expect(asked).toEqual([{ audio: CLEANUP }]);
    });

    test(`a picked microphone is asked for exactly`, async () => {
        const { open, asked } = browser();
        await openMicWith(open, `quadcast`);
        expect(asked).toEqual([{ audio: { ...CLEANUP, deviceId: { exact: `quadcast` } } }]);
    });

    test(`a picked microphone that is not there falls back to the browser's`, async () => {
        for (const name of [`OverconstrainedError`, `NotFoundError`]) {
            const { open, asked } = browser((constraints) => (picksDevice(constraints) ? failure(name) : undefined));
            await expect(openMicWith(open, `unplugged`)).resolves.toBe(`stream`);
            expect(asked).toEqual([{ audio: { ...CLEANUP, deviceId: { exact: `unplugged` } } }, { audio: CLEANUP }]);
        }
    });

    test(`a refusal is not a missing device: it is said, not worked around`, async () => {
        const { open, asked } = browser(() => failure(`NotAllowedError`));
        await expect(openMicWith(open, `quadcast`)).rejects.toMatchObject({ name: `NotAllowedError` });
        expect(asked).toHaveLength(1);
    });
});

describe(`listMics`, () => {
    const device = (deviceId: string, label: string, kind: MediaDeviceKind = `audioinput`): ListedDevice => ({ deviceId, label, kind });

    test(`the browser's inputs, without its aliases for the default and communications device`, async () => {
        const listed = await listMics(async () => [
            device(`default`, `Default - Microphone (HyperX QuadCast)`),
            device(`communications`, `Communications - Microphone (Realtek(R) Audio)`),
            device(`quadcast`, `Microphone (HyperX QuadCast)`),
            device(`c920`, `Microphone (HD Pro Webcam C920)`),
            device(`speakers`, `Speakers (Realtek(R) Audio)`, `audiooutput`),
        ]);
        expect(listed).toEqual({
            mics: [
                { id: `quadcast`, label: `Microphone (HyperX QuadCast)` },
                { id: `c920`, label: `Microphone (HD Pro Webcam C920)` },
            ],
            named: true,
        });
    });

    test(`before the site may use a microphone the browser names none`, async () => {
        expect(await listMics(async () => [device(``, ``)])).toEqual({ mics: [], named: false });
    });
});

test(`a pick is held, and dropping it leaves the choice to the browser again`, () => {
    chooseMic(`quadcast`);
    expect(chosenMic.value).toBe(`quadcast`);
    chooseMic(undefined);
    expect(chosenMic.value).toBeUndefined();
});
