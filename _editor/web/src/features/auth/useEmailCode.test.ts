import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { installI18n } from "@intentic/ui/i18n";
import { ref } from "vue";
import { EmailCodeError } from "../../client/auth/emailCode";
import { inSetup } from "../../testing/inSetup";
import { type Track, WAIT_HELP_MS } from "./emailCodeEvents";
import { RESEND_AFTER_MS, useEmailCode } from "./useEmailCode";

// What the emailed-code road tells analytics: every outcome as an event named by the screen it is on, a refusal by its
// coded reason, a minute on the code step with nothing typed counted once, and never the address or the code.

const sendEmailCode = jest.fn<(email: string) => Promise<void>>();
const signInWithEmailCode = jest.fn<(email: string, otp: string, options?: { readonly adding?: boolean }) => Promise<void>>();
const track = jest.fn<Track>();
const onSignedIn = jest.fn<() => void>();

let stop: (() => void) | undefined;
const start = (options: { googleOffered?: boolean; lockedEmail?: string } = {}) => {
    const set = inSetup(
        () =>
            useEmailCode({
                surface: `login`,
                googleOffered: ref(options.googleOffered ?? false),
                lockedEmail: ref(options.lockedEmail),
                onSignedIn,
                auth: { sendEmailCode, signInWithEmailCode },
                track,
            }),
        { plugins: [installI18n] },
    );
    stop = set.stop;
    return set.result;
};

// Every value any event carried, flattened, so a test can say the address appears in none of them.
const everyValue = (): string => JSON.stringify(track.mock.calls);

beforeEach(() => {
    sendEmailCode.mockReset().mockResolvedValue(undefined);
    signInWithEmailCode.mockReset().mockResolvedValue(undefined);
    track.mockReset();
    onSignedIn.mockReset();
    jest.useFakeTimers();
});

afterEach(() => {
    stop?.();
    stop = undefined;
    jest.useRealTimers();
});

it(`counts the request, says whether a Google address was the hint's case, and the email sign-in it ends in`, async () => {
    const block = start({ googleOffered: true });
    block.typed.value = `Ana@Gmail.com`;

    await block.send();
    block.typeCode(`123456`);
    await advanceTimersByTimeAsync(0);

    expect(sendEmailCode).toHaveBeenCalledWith(`ana@gmail.com`);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(track.mock.calls).toEqual([
        [`signin_code_requested`, { surface: `login`, google_address: true }],
        [`signin_completed`, { method: `email`, via: `code`, surface: `login`, help_shown: false }],
    ]);
    expect(everyValue()).not.toContain(`gmail`);
    expect(everyValue()).not.toContain(`123456`);
});

it(`leaves google_address off where no Google hint applies`, async () => {
    const block = start({ googleOffered: true, lockedEmail: `ana@gmail.com` });

    await block.send();

    expect(track.mock.calls).toEqual([[`signin_code_requested`, { surface: `login` }]]);
});

it(`counts a refused send by its coded reason and stays on the address`, async () => {
    sendEmailCode.mockRejectedValue(new EmailCodeError(`rate-limited`, `Too many codes asked for at once.`));
    const block = start();
    block.typed.value = `ana@corp.example`;

    await block.send();

    expect(block.step.value).toBe(`address`);
    expect(track.mock.calls).toEqual([
        [`signin_code_requested`, { surface: `login` }],
        [`signin_code_failed`, { surface: `login`, stage: `send`, reason: `rate-limited` }],
    ]);
});

it(`names a request that got no answer as network, and a wrong code as invalid`, async () => {
    const block = start();
    block.typed.value = `ana@corp.example`;
    await block.send();
    signInWithEmailCode.mockRejectedValueOnce(new EmailCodeError(`invalid`, `That code is not right.`));
    block.typeCode(`111111`);
    await advanceTimersByTimeAsync(0);
    // Past the resend countdown (RESEND_AFTER_MS), whose clock ticks once a second.
    await advanceTimersByTimeAsync(RESEND_AFTER_MS + 1_000);
    sendEmailCode.mockRejectedValue(new TypeError(`Failed to fetch`));

    await block.resend();

    expect(track.mock.calls.slice(1)).toEqual([
        [`signin_code_failed`, { surface: `login`, stage: `verify`, reason: `invalid` }],
        [`signin_code_resent`, { surface: `login`, help_shown: false }],
        [`signin_code_failed`, { surface: `login`, stage: `resend`, reason: `network` }],
    ]);
    expect(onSignedIn).toHaveBeenCalledTimes(0);
});

it(`offers help and counts the wait once, a minute after the code went out with nothing typed`, async () => {
    const block = start();
    block.typed.value = `ana@corp.example`;
    await block.send();

    await advanceTimersByTimeAsync(WAIT_HELP_MS - 1);
    expect(block.waitedLong.value).toBe(false);
    await advanceTimersByTimeAsync(1);

    expect(block.waitedLong.value).toBe(true);
    expect(track).toHaveBeenLastCalledWith(`signin_code_waiting`, { surface: `login` });

    // A fresh code waited on as long again is the same reader's same wait: counted once.
    await advanceTimersByTimeAsync(1_000);
    await block.resend();
    await advanceTimersByTimeAsync(WAIT_HELP_MS);
    block.typeCode(`123456`);
    await advanceTimersByTimeAsync(0);

    expect(track.mock.calls.map(([event]) => event)).toEqual([
        `signin_code_requested`,
        `signin_code_waiting`,
        `signin_code_resent`,
        `signin_completed`,
    ]);
    expect(track).toHaveBeenCalledWith(`signin_code_resent`, { surface: `login`, help_shown: true });
    expect(track).toHaveBeenLastCalledWith(`signin_completed`, { method: `email`, via: `code`, surface: `login`, help_shown: true });
});

it(`stays quiet for a reader who has started typing the code, or gone back to the address`, async () => {
    const block = start();
    block.typed.value = `ana@corp.example`;
    await block.send();
    block.typeCode(`12`);

    await advanceTimersByTimeAsync(WAIT_HELP_MS);
    expect(block.waitedLong.value).toBe(false);

    block.typeCode(``);
    block.changeAddress();
    await advanceTimersByTimeAsync(WAIT_HELP_MS);

    expect(block.waitedLong.value).toBe(false);
    expect(track.mock.calls.map(([event]) => event)).toEqual([`signin_code_requested`]);
});
