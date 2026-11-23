// A runner's browser window as this sandbox lists it: `<runner>~<own name>`, split on the first `~`; its view asked for
// under the runner's own name through the conversation that opened it (else one on that runner); and the window a runner
// conversation's hand-off opens.
import { conversationWindow, runnerWindowName, runnerWindowView, splitRunnerWindow } from "./runnerWindows";

it("names a runner's window apart from this sandbox's, and reads the name back", () => {
    expect(runnerWindowName(`rog`, `browser-a~b`)).toBe(`rog~browser-a~b`);
    expect(splitRunnerWindow(`rog~browser-a~b`)).toEqual({ runner: `rog`, own: `browser-a~b` });
    expect([splitRunnerWindow(`browser-abc`), splitRunnerWindow(`~x`), splitRunnerWindow(`rog~`)]).toEqual([undefined, undefined, undefined]);
});

it("asks for a runner window's picture under the runner's own name, through its owner or a conversation on that runner", () => {
    const on = (runner: string): string | undefined => (runner === `rog` ? `placed` : undefined);
    expect(runnerWindowView({ name: `rog~browser-1`, runner: `rog`, owner: `conv-1` }, on)).toEqual({ conversationId: `conv-1`, kind: `browser-view`, session: `browser-1` });
    expect(runnerWindowView({ name: `rog~browser-1`, runner: `rog` }, on)).toEqual({ conversationId: `placed`, kind: `browser-view`, session: `browser-1` });
    expect(runnerWindowView({ name: `z440~browser-1`, runner: `z440` }, on)).toBeUndefined();
    expect(runnerWindowView({ name: `browser-1`, owner: `conv-1` }, on)).toBeUndefined();
});

it("opens the hand-off's window by its merged name, else the window on that runner the conversation opened", () => {
    const windows = [
        { name: `rog~browser-own`, runner: `rog`, owner: `conv-1`, running: true },
        { name: `browser-own`, owner: `conv-1`, running: true },
    ];
    expect(conversationWindow(windows, { runner: `rog`, conversationId: `conv-1`, own: `browser-own` })).toBe(`rog~browser-own`);
    expect(conversationWindow(windows, { runner: `rog`, conversationId: `conv-1`, own: `browser-renamed` })).toBe(`rog~browser-own`);
    expect(conversationWindow(windows, { runner: `rog`, conversationId: `conv-2`, own: `browser-new` })).toBe(`rog~browser-new`);
});
