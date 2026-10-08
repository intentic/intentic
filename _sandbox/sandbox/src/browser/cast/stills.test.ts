import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { STILL_DELAY_MS, STILL_IDLE_MS } from "./screencast.js";
import { createStillTaker, isLoud, QUIET_BYTES } from "./stills.js";

// The still taker decides, per frame, whether the client keeps a sharp still or paints the video; the wrong answer is
// either blurry text while reading or a still hiding real motion, neither of which errors. Driven with fake time and
// a fake capture, so every branch is a stated sequence of frames.

beforeEach(() => {
    jest.useFakeTimers();
});
afterEach(() => {
    jest.useRealTimers();
});

const loud = { key: false, bytes: QUIET_BYTES + 1 };
const quiet = { key: false, bytes: 200 };
const keyframe = { key: true, bytes: 60_000 };

// One taker over a capture that answers what `shot` holds; `sent` is every still that went to the client.
const taker = (shot: { value: string | undefined }) => {
    const sent: Buffer[] = [];
    const capture = jest.fn(async () => shot.value);
    const made = createStillTaker({ capture, send: (still) => sent.push(still) });
    return { made, capture, sent };
};

describe("isLoud", () => {
    test("a keyframe is never motion, a delta is by its size", () => {
        expect(isLoud(keyframe)).toBe(false);
        expect(isLoud(quiet)).toBe(false);
        expect(isLoud(loud)).toBe(true);
        expect(isLoud({ key: false, bytes: QUIET_BYTES })).toBe(false);
    });
});

test("a still is taken once the page settles, and the frames after it are quiet", async () => {
    const shot = { value: "AAAA" };
    const { made, capture, sent } = taker(shot);
    made.reset();
    expect(made.noteFrame(loud)).toBe("paint");
    // Nothing is taken while the page is still moving.
    await advanceTimersByTimeAsync(STILL_DELAY_MS - 1);
    expect(capture).not.toHaveBeenCalled();
    await advanceTimersByTimeAsync(2);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([Buffer.from("AAAA", "base64")]);
    // A quiet delta and the periodic keyframe both show nothing the still does not.
    expect(made.noteFrame(quiet)).toBe("quiet");
    expect(made.noteFrame(keyframe)).toBe("quiet");
});

test("real motion after a still paints again, and a fresh still follows the next settle", async () => {
    const shot = { value: "AAAA" };
    const { made, capture, sent } = taker(shot);
    made.reset();
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(sent).toHaveLength(1);
    // A loud frame is the page moving.
    await advanceTimersByTimeAsync(300);
    shot.value = "BBBB";
    expect(made.noteFrame(loud)).toBe("paint");
    expect(made.noteFrame(quiet)).toBe("paint");
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([Buffer.from("AAAA", "base64"), Buffer.from("BBBB", "base64")]);
});

test("an identical look is neither resent nor soon repeated, and a loud frame after a still is always motion", async () => {
    const shot = { value: "AAAA" };
    const { made, capture, sent } = taker(shot);
    made.reset();
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(sent).toHaveLength(1);
    // The look after a new still finds nothing new: not sent, and the looking backs off.
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    await advanceTimersByTimeAsync(STILL_IDLE_MS + 1);
    expect(capture.mock.calls.length).toBeLessThanOrEqual(3);
    // A grab of the display moves nothing on it, so a loud frame straight after one is the page moving.
    expect(made.noteFrame(loud)).toBe("paint");
    expect(made.noteFrame(quiet)).toBe("paint");
});

test("the pointer coming to rest gets another look: what it lit up replaces the still, which stands meanwhile", async () => {
    const shot = { value: "AAAA" };
    const { made, capture, sent } = taker(shot);
    made.reset();
    await advanceTimersByTimeAsync(2 * STILL_DELAY_MS + 2);
    expect(capture).toHaveBeenCalledTimes(2);
    // The pointer moves over a button, which lights up too little to read as motion.
    shot.value = "BBBB";
    for (let step = 0; step < 5; step += 1) {
        made.noteInput();
        expect(made.noteFrame(quiet)).toBe("quiet");
        // oxlint-disable-next-line eslint/no-await-in-loop -- the pointer moving, a step at a time
        await advanceTimersByTimeAsync(STILL_DELAY_MS / 2);
    }
    // Still moving: nothing looked at yet.
    expect(capture).toHaveBeenCalledTimes(2);
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(sent).toEqual([Buffer.from("AAAA", "base64"), Buffer.from("BBBB", "base64")]);
});

test("a click or keystroke withdraws the still: its small answer paints, and a fresh still follows the settle", async () => {
    const shot = { value: "AAAA" };
    const { made, capture, sent } = taker(shot);
    made.reset();
    // The first still, then the look after it, which finds the page unchanged and ends the looking.
    await advanceTimersByTimeAsync(2 * STILL_DELAY_MS + 2);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(made.noteFrame(quiet)).toBe("quiet");
    // A typed character: a few hundred bytes of video, which size alone would keep under the still.
    shot.value = "BBBB";
    made.noteAction();
    expect(made.noteFrame(quiet)).toBe("paint");
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(sent).toEqual([Buffer.from("AAAA", "base64"), Buffer.from("BBBB", "base64")]);
    expect(made.noteFrame(quiet)).toBe("quiet");
});

test("a still withdrawn by a click is sent again even when the page did not change, since the client dropped it", async () => {
    const shot = { value: "AAAA" };
    const { made, sent } = taker(shot);
    made.reset();
    await advanceTimersByTimeAsync(2 * STILL_DELAY_MS + 2);
    expect(sent).toHaveLength(1);
    made.noteAction();
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(sent).toEqual([Buffer.from("AAAA", "base64"), Buffer.from("AAAA", "base64")]);
});

test("a still that found something new is followed by another look, and an identical look ends it", async () => {
    const shot = { value: "AAAA" };
    const { made, capture, sent } = taker(shot);
    made.reset();
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(capture).toHaveBeenCalledTimes(1);
    // A caret blinking: a change no frame reads as motion, seen only because the page is looked at again.
    shot.value = "BBBB";
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(capture).toHaveBeenCalledTimes(2);
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(capture).toHaveBeenCalledTimes(3);
    await advanceTimersByTimeAsync(STILL_IDLE_MS + 1);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(sent).toEqual([Buffer.from("AAAA", "base64"), Buffer.from("BBBB", "base64")]);
});

test("a capture that fails leaves the still untaken and the frames painting", async () => {
    const shot = { value: undefined };
    const { made, capture, sent } = taker(shot);
    made.reset();
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    expect(made.noteFrame(quiet)).toBe("paint");
});

test("paused takes nothing; resuming owes a fresh still", async () => {
    const shot = { value: "AAAA" };
    const { made, capture } = taker(shot);
    made.reset();
    made.setPaused(true);
    await advanceTimersByTimeAsync(STILL_IDLE_MS);
    expect(capture).not.toHaveBeenCalled();
    made.setPaused(false);
    await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
    expect(capture).toHaveBeenCalledTimes(1);
});

test("stopped takes nothing more", async () => {
    const shot = { value: "AAAA" };
    const { made, capture } = taker(shot);
    made.reset();
    made.stop();
    await advanceTimersByTimeAsync(STILL_IDLE_MS);
    expect(capture).not.toHaveBeenCalled();
});

test("a still begun before the page changed under it (another tab, a click) is never sent", async () => {
    let answer: ((value: string) => void) | undefined;
    const sent: Buffer[] = [];
    const capture = jest.fn(
        () =>
            new Promise<string | undefined>((resolve) => {
                answer = resolve;
            }),
    );
    const made = createStillTaker({ capture, send: (still) => sent.push(still) });
    for (const change of [() => made.reset(), () => made.noteAction()]) {
        made.reset();
        await advanceTimersByTimeAsync(STILL_DELAY_MS + 1);
        expect(answer).toEqual(expect.any(Function));
        // The tab switches (or the owner clicks) while the old page is still being photographed.
        change();
        answer?.("AAAA");
        answer = undefined;
        await advanceTimersByTimeAsync(0);
        expect(sent).toEqual([]);
        // Nothing stands for the page, so the frames that follow paint.
        expect(made.noteFrame(quiet)).toBe("paint");
    }
    made.stop();
});
