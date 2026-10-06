import { unknownKeyIn } from "./input-linux.js";

/* xdotool answers an unknown key name on stderr and exits 0, so a press of it looked like it worked. */

test("a key name xdotool does not know is read off what it said", () => {
    expect(unknownKeyIn("(symbol) No such key name 'NotAKey'. Ignoring it.\n")).toBe("NotAKey");
    expect(unknownKeyIn("(symbol) No such key name 'ctrl+NotAKey'. Ignoring it.\n(symbol) No such key name 'ctrl+NotAKey'. Ignoring it.\n")).toBe("ctrl+NotAKey");
});

test("anything else it says is not an unknown key", () => {
    expect(unknownKeyIn("")).toBeUndefined();
    expect(unknownKeyIn("Warning: something else\n")).toBeUndefined();
});
