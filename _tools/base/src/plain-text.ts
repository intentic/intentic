// Strips terminal-only escapes and control bytes from captured output before it becomes prose (a log tail, a test
// failure), since a prompt cannot render them. Lossless, unlike the line-dropping noise cleaners in bin/cleaners.mjs.
// Lives in base since both the daemon and the deployments extension need it.

// CSI sequences, OSC sequences (title sets, hyperlinks), and lone two-byte escapes.
// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// What is left once the escapes are gone: BEL, backspace, form feed, a stray ESC. Tab and newline are text.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// A progress bar redraws one line with `\r`; only the last non-empty frame was ever on screen, since a trailing empty
// one just parks the cursor.
const lastFrame = (line: string): string => line.split("\r").findLast((frame) => frame !== "") ?? "";

export const plainText = (output: string): string => output.replace(ANSI, "").split("\n").map(lastFrame).join("\n").replace(CONTROL, "");
