import { PassThrough, Readable } from "node:stream";
import { readConfirmed, readHidden, readStdin, type SecretTerminal } from "./secret-input.js";

// How a value or a passphrase is taken in: piped with one trailing newline dropped, or typed with echo off, so the
// terminal shows the prompt and never a character of what was typed.

// A terminal that types `keys` once a prompt is shown, and keeps what was written to it.
const terminal = (...keys: string[]): SecretTerminal & { readonly shown: string[] } => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (): void => undefined });
    const shown: string[] = [];
    return {
        input,
        shown,
        output: {
            write: (chunk: string): void => {
                shown.push(chunk);
                if (chunk.endsWith(": ")) {
                    const typed = keys.shift();
                    if (typed !== undefined) {
                        setImmediate(() => input.write(typed));
                    }
                }
            },
        },
    };
};

test("a piped value loses one trailing newline, and only one", async () => {
    expect(await readStdin(Readable.from([Buffer.from("s3cret\n")]))).toBe("s3cret");
    expect(await readStdin(Readable.from([Buffer.from("s3cret\r\n")]))).toBe("s3cret");
    expect(await readStdin(Readable.from([Buffer.from("two\nlines\n\n")]))).toBe("two\nlines\n");
    await expect(readStdin(Readable.from([Buffer.from("\n")]))).rejects.toMatchObject({ code: "usage" });
});

test("a typed value is never echoed, and Backspace takes back a character", async () => {
    const term = terminal("hunx\u007fter2\r");
    expect(await readHidden("Value: ", term)).toBe("hunter2");
    expect(term.shown.join("")).toBe("Value: \n");
});

test("typing it twice must match, and Ctrl-C cancels", async () => {
    expect(await readConfirmed("Passphrase", terminal("correct horse\r", "correct horse\r"))).toBe("correct horse");
    await expect(readConfirmed("Passphrase", terminal("one\r", "two\r"))).rejects.toMatchObject({ code: "usage" });
    await expect(readHidden("Value: ", terminal("ab\u0003"))).rejects.toMatchObject({ code: "declined" });
});

test("with no terminal it says to pipe the value in", async () => {
    const piped: SecretTerminal = { input: new PassThrough(), output: { write: () => undefined } };
    await expect(readHidden("Value: ", piped)).rejects.toThrow("--stdin");
});
