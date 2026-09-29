import "@intentic/testing/dom";
import { readerHere, receiveReaderNote } from "./readerHere";

// A test page never has the focus, so the reader is here only as far as other windows say so.
describe(`whether the reader is in the app`, () => {
    it(`is while another window of the app says it has the focus, and stops when it lets go`, () => {
        expect(readerHere.value).toBe(false);
        receiveReaderNote({ kind: `focus`, id: `chat-window`, focused: true });
        expect(readerHere.value).toBe(true);
        receiveReaderNote({ kind: `focus`, id: `chat-window`, focused: false });
        expect(readerHere.value).toBe(false);
    });

    it(`waits for every window that claimed the focus to let go`, () => {
        receiveReaderNote({ kind: `focus`, id: `one`, focused: true });
        receiveReaderNote({ kind: `focus`, id: `two`, focused: true });
        receiveReaderNote({ kind: `focus`, id: `one`, focused: false });
        expect(readerHere.value).toBe(true);
        receiveReaderNote({ kind: `focus`, id: `two`, focused: false });
        expect(readerHere.value).toBe(false);
    });
});
