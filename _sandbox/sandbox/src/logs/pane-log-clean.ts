#!/usr/bin/env node
import { rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import type { Terminal as TerminalType } from "@xterm/headless";

// Pane output (piped by log-files.ts's pipe-pane hooks) is a live terminal stream, not text: redraws and cursor moves
// would concatenate into garbage if escapes were merely stripped. One process per pane replays it through a headless VT
// emulator and persists the rendered screen.

// @xterm/headless is CommonJS; ESM named-export detection fails, so it loads via require, typed via import.
const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;
const SCROLLBACK = 10_000;
const FLUSH_DEBOUNCE_MS = 300;
const FLUSH_MAX_MS = 2_000;

// Strips the ESC k <title> ST/BEL sequence oh-my-zsh uses for the tmux tab title; xterm.js doesn't recognize it and
// renders it as text. Stateful: a title or a lone trailing ESC can straddle a chunk boundary.
class TitleStripper {
    #inTitle = false;
    #pendingEsc = false;

    feed(text: string): string {
        if (!this.#inTitle && !this.#pendingEsc && !text.includes("\x1b")) {
            return text;
        }
        let out = "";
        for (const char of text) {
            if (this.#pendingEsc) {
                this.#pendingEsc = false;
                if (this.#inTitle) {
                    if (char === "\\") {
                        this.#inTitle = false;
                    } // ESC \ (ST) ends the title
                    continue; // drop the held ESC and this char either way
                }
                if (char === "k") {
                    this.#inTitle = true;
                    continue;
                }
                out += "\x1b"; // a real ESC we held across the boundary: keep it, then handle char
            }
            if (this.#inTitle) {
                if (char === "\x07") {
                    this.#inTitle = false;
                } // BEL also ends the title
                else if (char === "\x1b") {
                    this.#pendingEsc = true;
                }
                continue;
            }
            if (char === "\x1b") {
                this.#pendingEsc = true;
                continue;
            }
            out += char;
        }
        return out;
    }
}

// Renders the buffer (scrollback + viewport) to plain text, trailing blank lines trimmed. Not addon-serialize, which
// re-emits SGR color escapes.
const render = (term: TerminalType): string => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
        lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    while (lines.length > 0 && lines.at(-1) === "") {
        lines.pop();
    }
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
};

// Testable core: bytes in, rendered plain text out. `write` resolves once xterm has parsed the chunk.
export const createPaneRenderer = ({ cols, rows, scrollback }: { cols: number; rows: number; scrollback: number }) => {
    const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    const stripper = new TitleStripper();
    const decoder = new StringDecoder("utf8");
    return {
        write: (chunk: Buffer): Promise<void> => new Promise((resolve) => term.write(stripper.feed(decoder.write(chunk)), resolve)),
        render: (): string => render(term),
    };
};

const main = async (): Promise<void> => {
    const [file, width, height] = process.argv.slice(2);
    if (file === undefined) {
        process.stderr.write("pane-log-clean: missing output file argument\n");
        process.exitCode = 1;
        return;
    }
    const { write, render: renderNow } = createPaneRenderer({
        cols: Number(width) || DEFAULT_COLS,
        rows: Number(height) || DEFAULT_ROWS,
        scrollback: SCROLLBACK,
    });

    const tmp = `${file}.tmp`;
    let dirty = false;
    let draining: Promise<void> | undefined;
    const persist = async (): Promise<void> => {
        await writeFile(tmp, renderNow());
        await rename(tmp, file); // atomic swap so a concurrent /logs tail never reads a half-written file
    };
    // Coalescing, non-overlapping flusher: repeated triggers just re-arm `dirty`; the loop drains it.
    const drain = (): Promise<void> => {
        if (draining !== undefined) {
            return draining;
        }
        draining = (async () => {
            try {
                while (dirty) {
                    dirty = false;
                    await persist();
                }
            } catch (error) {
                process.stderr.write(`pane-log-clean: ${String(error)}\n`);
            } finally {
                draining = undefined;
            }
        })();
        return draining;
    };

    let debounce: ReturnType<typeof setTimeout> | undefined;
    let maxWait: ReturnType<typeof setTimeout> | undefined;
    const trigger = (): void => {
        dirty = true;
        void drain();
    };
    const schedule = (): void => {
        if (debounce !== undefined) {
            clearTimeout(debounce);
        }
        debounce = setTimeout(() => {
            if (maxWait !== undefined) {
                clearTimeout(maxWait);
                maxWait = undefined;
            }
            trigger();
        }, FLUSH_DEBOUNCE_MS);
        maxWait ??= setTimeout(() => {
            maxWait = undefined;
            trigger();
        }, FLUSH_MAX_MS);
    };

    for await (const chunk of process.stdin) {
        await write(chunk as Buffer);
        schedule();
    }

    if (debounce !== undefined) {
        clearTimeout(debounce);
    }
    if (maxWait !== undefined) {
        clearTimeout(maxWait);
    }
    if (draining !== undefined) {
        await draining;
    } // let any in-flight flush settle, then write the final state
    await persist();
};

// Importable for tests; executable as the bin (symlinked to /usr/local/bin/pane-log-clean).
if (process.argv[1]?.endsWith("pane-log-clean") || process.argv[1]?.endsWith("pane-log-clean.js")) {
    main().catch((error) => {
        process.stderr.write(`pane-log-clean: ${String(error)}\n`);
        process.exitCode = 1;
    });
}
