import type { Focus } from "../policy.js";

// A TYPIST looks at where the keyboard's focus is, then types a value there, in two steps so the keyring can decide in
// between (policy.ts typingDecision, perhaps a person's yes) and check again that nothing moved. It never answers with
// the value: what comes back is the program it went to and what kind of field.

// Where a value is typed: the focused window on this computer, or a phone attached over adb.
export type Place = { readonly kind: "window" } | { readonly kind: "android"; readonly serial: string };

// What an inspection saw: the focus as policy reads it, and the platform's own name for the focused window (an hwnd
// and UI Automation runtime id, an X window id, a process id, a package), which typing checks again before the first
// character and after each.
export interface Seen {
    readonly focus: Focus;
    readonly handle: string;
}

export type Inspected = { readonly ok: true; readonly seen: Seen } | { readonly ok: false; readonly reason: string };

export type Typed =
    | { readonly ok: true }
    // `partly`: some of the value went in before typing stopped, so the person knows to look where it went.
    | { readonly ok: false; readonly reason: string; readonly partly: boolean };

export interface Typist {
    readonly inspect: (place: Place) => Promise<Inspected>;
    readonly type: (place: Place, seen: Seen, value: string) => Promise<Typed>;
}

// A typist for a platform with no way to type: every call says so.
export const noTypist = (why: string): Typist => ({
    inspect: () => Promise.resolve({ ok: false, reason: why }),
    type: () => Promise.resolve({ ok: false, reason: why, partly: false }),
});

// The window typist and the phone typist behind one Typist, by where the value goes.
export const typistFor = (window: Typist, android: Typist): Typist => ({
    inspect: async (place) => await (place.kind === "window" ? window : android).inspect(place),
    type: async (place, seen, value) => await (place.kind === "window" ? window : android).type(place, seen, value),
});
