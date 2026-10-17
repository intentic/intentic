// What becomes of a press on Google's own button, read off the only things this page can see: the press itself (or
// its focus moving into Google's frame), and its own focus leaving for Google's window and coming back. A reader on a
// browser without FedCM pressed a button whose pop-up never answered for thirteen minutes with nothing on the page
// saying so.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { effectScope, type EffectScope, ref } from "vue";

const track = jest.fn();
jest.mock(`../../app/analytics`, () => ({ track, replaySessionId: () => undefined }));

const { useGooglePress } = await import("./googlePress");

let scope: EffectScope | undefined;
let slot: HTMLElement;
// Google's button as Google draws it into the page where it opens a pop-up, and the frame it uses elsewhere.
let drawn: HTMLElement;
let frame: HTMLIFrameElement;
// Whether this window holds the focus, which is what Google's window coming up in front of it takes away.
let focused = true;

const watchPresses = (): ReturnType<typeof useGooglePress> => {
    scope = effectScope();
    return scope.run(() => useGooglePress(ref(slot), `login`))!;
};

const press = (target: Element = drawn): void => {
    target.dispatchEvent(new Event(`pointerdown`, { bubbles: true }));
};

beforeEach(() => {
    jest.useFakeTimers();
    track.mockReset();
    focused = true;
    jest.spyOn(document, `hasFocus`).mockImplementation(() => focused);
    slot = document.createElement(`div`);
    drawn = document.createElement(`div`);
    drawn.setAttribute(`role`, `button`);
    frame = document.createElement(`iframe`);
    slot.append(drawn, frame);
    document.body.append(slot);
});

afterEach(() => {
    scope?.stop();
    scope = undefined;
    jest.restoreAllMocks();
    jest.useRealTimers();
    document.body.innerHTML = ``;
});

it(`says nothing before a press, however long the page sits`, async () => {
    const { stalled } = watchPresses();

    await advanceTimersByTimeAsync(60_000);

    expect(stalled.value).toBe(false);
});

it(`gives Google's window as long as it stays up, then a long grace once the reader is back`, async () => {
    const { stalled } = watchPresses();

    press();
    focused = false;
    await advanceTimersByTimeAsync(60_000);
    // A reader still in Google's window is still signing in, however long it takes.
    expect(stalled.value).toBe(false);

    focused = true;
    await advanceTimersByTimeAsync(24_000);
    expect(stalled.value).toBe(false);
    await advanceTimersByTimeAsync(1_500);

    expect(stalled.value).toBe(true);
    expect(track).toHaveBeenCalledWith(`sandbox_signin_gate`, {
        reason: `button-stalled`,
        mode: `button`,
        surface: `login`,
        fedcm: expect.any(Boolean),
        left: true,
    });
});

// A blocked pop-up never takes the focus at all: the press just goes nowhere.
it(`gives up on a press that opened nothing this page could see`, async () => {
    const { stalled } = watchPresses();

    press();
    await advanceTimersByTimeAsync(7_000);
    expect(stalled.value).toBe(false);
    await advanceTimersByTimeAsync(1_500);

    expect(stalled.value).toBe(true);
    expect(track).toHaveBeenCalledWith(`sandbox_signin_gate`, expect.objectContaining({ reason: `button-stalled`, left: false }));
});

it(`stays quiet once the press was answered`, async () => {
    const { stalled, answered } = watchPresses();

    press();
    focused = false;
    await advanceTimersByTimeAsync(1_000);
    answered();
    focused = true;
    await advanceTimersByTimeAsync(30_000);

    expect(stalled.value).toBe(false);
    expect(track).not.toHaveBeenCalled();
});

// Where Google draws its button in a frame of its own, the press never reaches this document: the window's focus
// moving into that frame is all there is of it.
it(`counts focus moving into Google's frame as a press`, async () => {
    const { stalled } = watchPresses();

    frame.focus();
    window.dispatchEvent(new Event(`blur`));
    await advanceTimersByTimeAsync(8_500);

    expect(stalled.value).toBe(true);
});

it(`does not count the keyboard passing through Google's frame`, async () => {
    const { stalled } = watchPresses();

    document.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Tab` }));
    frame.focus();
    window.dispatchEvent(new Event(`blur`));
    await advanceTimersByTimeAsync(30_000);

    expect(stalled.value).toBe(false);
});

it(`ignores presses anywhere else on the page`, async () => {
    const elsewhere = document.createElement(`button`);
    document.body.append(elsewhere);
    const { stalled } = watchPresses();

    press(elsewhere);
    await advanceTimersByTimeAsync(30_000);

    expect(stalled.value).toBe(false);
});

// The answer arriving moves the page on, which takes the button with it: no press is left to time.
it(`stops when the button leaves the page`, async () => {
    const { stalled } = watchPresses();

    press();
    slot.remove();
    await advanceTimersByTimeAsync(30_000);

    expect(stalled.value).toBe(false);
    expect(track).not.toHaveBeenCalled();
});

it(`reports a stalled page once, however many presses follow`, async () => {
    watchPresses();

    press();
    await advanceTimersByTimeAsync(8_500);
    press();
    await advanceTimersByTimeAsync(8_500);

    expect(track).toHaveBeenCalledTimes(1);
});

// The field case: focus came back for a moment (a click on the page, a passkey prompt) while Google's window was still
// signing the reader in, and the credential landed 48 s after the press.
it(`does not call a sign-in dead because focus came back for a moment, and counts the one that finishes`, async () => {
    const { stalled, completed } = watchPresses();

    press();
    focused = false;
    await advanceTimersByTimeAsync(10_000);
    focused = true;
    await advanceTimersByTimeAsync(3_000);
    expect(stalled.value).toBe(false);
    focused = false;
    await advanceTimersByTimeAsync(35_000);
    completed();

    expect(stalled.value).toBe(false);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(`signin_completed`, { method: `google`, surface: `login`, stall_shown: false });
});

it(`takes the note down when the credential arrives after it was shown`, async () => {
    const { stalled, completed } = watchPresses();

    press();
    await advanceTimersByTimeAsync(8_500);
    expect(stalled.value).toBe(true);
    completed();

    expect(stalled.value).toBe(false);
    expect(track).toHaveBeenLastCalledWith(`signin_completed`, { method: `google`, surface: `login`, stall_shown: true });
});

it(`does not count a dismissal as a completed sign-in`, async () => {
    const { answered } = watchPresses();

    press();
    answered();

    expect(track).not.toHaveBeenCalled();
});
