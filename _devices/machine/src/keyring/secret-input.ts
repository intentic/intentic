import { KeyringCliError } from "./flags.js";

// A VALUE OR A PASSPHRASE, TAKEN FROM THE PERSON WITHOUT IT EVER BEING SHOWN OR PASSED ON A COMMAND LINE: typed at the
// terminal with echo off (twice, so a typo is not sealed into the vault), or piped on stdin for a program that holds it
// (the desktop app). Never an argument: another process of the same user can read a command line, and a shell keeps it in
// its history. Nothing here writes the value anywhere but back to its caller.

// What a value may be at most: a sealed box carries 64 KiB of base64, and a value sealed is a little larger than itself.
export const VALUE_MAX_BYTES = 32 * 1024;

// The terminal as this file uses it: Node's own stdin and stderr, or a test's.
export interface SecretTerminal {
    readonly input: NodeJS.ReadableStream & { readonly isTTY?: boolean; setRawMode?: (raw: boolean) => void };
    readonly output: { write: (chunk: string) => void };
}

const realTerminal = (): SecretTerminal => ({ input: process.stdin, output: process.stderr });

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = new Set(["\u007f", "\b"]);

/** One line typed with echo off. Ctrl-C cancels; Backspace takes back the last character. */
export const readHidden = async (prompt: string, terminal: SecretTerminal = realTerminal()): Promise<string> => {
    const { input, output } = terminal;
    if (input.isTTY !== true || input.setRawMode === undefined) {
        throw new KeyringCliError("usage", "There is no terminal here to type it into without it showing: pipe it in and pass --stdin.");
    }
    const setRawMode = input.setRawMode.bind(input);
    output.write(prompt);
    setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    try {
        return await new Promise<string>((resolve, reject) => {
            const typed: string[] = [];
            const onData = (chunk: string | Buffer): void => {
                for (const character of String(chunk)) {
                    if (character === "\r" || character === "\n" || (character === CTRL_D && typed.length === 0)) {
                        input.off("data", onData);
                        resolve(typed.join(""));
                        return;
                    }
                    if (character === CTRL_C) {
                        input.off("data", onData);
                        reject(new KeyringCliError("declined", "Cancelled: nothing was typed in."));
                        return;
                    }
                    if (BACKSPACE.has(character)) {
                        typed.pop();
                    } else if (character >= " ") {
                        typed.push(character);
                    }
                }
            };
            input.on("data", onData);
        });
    } finally {
        setRawMode(false);
        input.pause();
        output.write("\n");
    }
};

/** A value typed twice with echo off, refused when the two differ or it is empty. */
export const readConfirmed = async (what: string, terminal: SecretTerminal = realTerminal()): Promise<string> => {
    const first = await readHidden(`${what}: `, terminal);
    if (first === "") {
        throw new KeyringCliError("usage", `Nothing was typed for ${what.toLowerCase()}.`);
    }
    const again = await readHidden(`${what}, again to confirm: `, terminal);
    if (again !== first) {
        throw new KeyringCliError("usage", "The two did not match, so nothing was kept: run the same command again.");
    }
    return first;
};

/** Everything on stdin, with one trailing newline taken off (what `echo` and a here-string add). */
export const readStdin = async (input: NodeJS.ReadableStream = process.stdin): Promise<string> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
        const bytes = Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > VALUE_MAX_BYTES) {
            throw new KeyringCliError("usage", `What came on stdin is longer than ${VALUE_MAX_BYTES / 1024} KiB, more than any value the keyring keeps.`);
        }
        chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const value = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
    if (value === "") {
        throw new KeyringCliError("usage", "Nothing came on stdin.");
    }
    return value;
};
