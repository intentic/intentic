import { requestCaret, takeCaret } from "./caretRequest";

// A new file's editor takes the caret once; nothing else does, and nor does it after the request has gone stale.

it(`hands the caret to the first editor that mounts for the new file, and to no later one`, () => {
    requestCaret(`notes/new.md`, 1_000);
    expect(takeCaret(`notes/other.md`, 1_100)).toBe(false);
    expect(takeCaret(`notes/new.md`, 1_200)).toBe(true);
    expect(takeCaret(`notes/new.md`, 1_300)).toBe(false);
});

it(`lets a request lapse when the editor mounts long after it`, () => {
    requestCaret(`slow.txt`, 1_000);
    expect(takeCaret(`slow.txt`, 1_000 + 10_000)).toBe(false);
    // Spent by that answer, so a later open of the same file is an ordinary one.
    expect(takeCaret(`slow.txt`, 1_000 + 10_001)).toBe(false);
});

it(`takes a request made just before the window closes`, () => {
    requestCaret(`edge.txt`, 5_000);
    expect(takeCaret(`edge.txt`, 5_000 + 9_999)).toBe(true);
});
