import { ref } from "vue";
import * as desktopOriginal from "../../../app/environments/desktop";
import type { WakePhase } from "./useWakeListener";
import type { DesktopWakeListener } from "./wakeDesktop";

// Pins what the page tells the desktop app about listening and what it does with the tray's asks: the state the tray
// reads (a microphone held while the window is off screen reads as needing a press), the link's bounds, and asks the
// app says again until the page agrees changing nothing the second time.

const links: string[] = [];
jest.mock(`../../../app/environments/desktop`, () => ({
    ...desktopOriginal,
    desktopApp: () => ({ version: `1.0.0`, installId: `x`, update: null, wake: true }),
    openDesktopLink: (link: string) => links.push(link),
}));

const { DESKTOP_WAKE_EVENT, desktopWakeLink, desktopWakeState, startWakeDesktop } = await import(`./wakeDesktop`);

const fakeListener = () => {
    const calls: string[] = [];
    const listener: DesktopWakeListener = {
        enabled: ref(true),
        phase: ref<WakePhase>(`listening`),
        pausedUntil: ref<number | undefined>(),
        word: ref(`Leon`),
        setEnabled: (on: boolean) => {
            calls.push(on ? `on` : `off`);
            listener.enabled.value = on;
            listener.pausedUntil.value = undefined;
        },
        pause: (minutes: number) => {
            calls.push(`pause:${minutes}`);
            listener.pausedUntil.value = Date.now() + minutes * 60_000;
        },
        resume: () => {
            calls.push(`resume`);
            listener.pausedUntil.value = undefined;
        },
    };
    return { listener, calls, raw: listener };
};

const ask = (detail: unknown): void => {
    window.dispatchEvent(new CustomEvent(DESKTOP_WAKE_EVENT, { detail }));
};

describe(`desktopWakeState`, () => {
    test(`reads as the tray says it`, () => {
        const { raw } = fakeListener();
        expect(desktopWakeState(raw, Date.now())).toBe(`listening`);
        raw.phase.value = `blocked`;
        expect(desktopWakeState(raw, Date.now())).toBe(`blocked`);
        raw.phase.value = `failed`;
        expect(desktopWakeState(raw, Date.now())).toBe(`error`);
        raw.pausedUntil.value = Date.now() + 60_000;
        expect(desktopWakeState(raw, Date.now())).toBe(`paused`);
        raw.enabled.value = false;
        expect(desktopWakeState(raw, Date.now())).toBe(`off`);
    });

    test(`a microphone still opening off screen needs the window shown, so it reads as blocked there`, () => {
        const { raw } = fakeListener();
        raw.phase.value = `starting`;
        expect(desktopWakeState(raw, Date.now(), true)).toBe(`listening`);
        expect(desktopWakeState(raw, Date.now(), false)).toBe(`blocked`);
    });
});

test(`the link names the state and the word, one line, bounded, and the end of a pause only with a pause`, () => {
    expect(desktopWakeLink(`listening`, `Leon`, undefined)).toBe(`intentic://wake?state=listening&word=Leon`);
    expect(desktopWakeLink(`paused`, `Leon`, 1_800_000_000_000.4)).toBe(`intentic://wake?state=paused&word=Leon&until=1800000000000`);
    expect(desktopWakeLink(`listening`, `Leon`, 1_800_000_000_000)).toBe(`intentic://wake?state=listening&word=Leon`);
    expect(new URL(desktopWakeLink(`off`, `a\nb${`c`.repeat(60)}`, undefined)).searchParams.get(`word`)).toHaveLength(40);
});

test(`the tray's asks are taken once, and asked again they change nothing`, () => {
    const { listener, calls } = fakeListener();
    links.length = 0;
    const stop = startWakeDesktop(listener);
    expect(links).toEqual([`intentic://wake?state=listening&word=Leon`]);
    ask({ do: `pause`, minutes: 60 });
    ask({ do: `pause`, minutes: 60 });
    ask({ do: `resume` });
    ask({ do: `resume` });
    ask({ do: `off` });
    ask({ do: `off` });
    ask({ do: `on` });
    ask({ do: `on` });
    ask({ do: `explode` });
    ask(`on`);
    expect(calls).toEqual([`pause:60`, `resume`, `off`, `on`]);
    stop();
    ask({ do: `off` });
    expect(calls).toHaveLength(4);
});
