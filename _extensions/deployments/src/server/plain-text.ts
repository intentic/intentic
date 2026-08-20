/* CAPTURED OUTPUT ON ITS WAY INTO PROSE, a suite's tail quoted in a pre-push fix, a CI job's log, a container's
 * log tail. Every one of them was written FOR A TERMINAL: colour, cursor moves, a spinner rewriting its own line,
 * a runner setting the window title. A terminal resolves those to a screen; a prompt does not, so pasted verbatim
 * they arrive as `▌[2m…▌[22m` litter that the model pays tokens for, the user reads as a corrupted message, and
 * the actual failure hides inside.
 *
 * WHY HERE AND NOT IN THE RUNNER. terminal-run.ts hands back what the command printed, and it has readers that
 * want exactly that (an ACP client renders it as terminal output). Cleaning belongs at the seam where output
 * stops being a terminal's and becomes text somebody reads, which is where each caller of this lives.
 *
 * The three rules are the terminal's own, and none of them can throw information away: an escape sequence carries
 * no text, a `\r` frame that another frame overwrote was never on screen, and a control byte has no rendering.
 * Kept deliberately narrow for that reason, the per-command noise cleaners (bin/cleaners.mjs) drop LINES, are
 * spec-gated and A/B-benchmarked, and none of that judgement belongs in a fix prompt's evidence. */

// CSI sequences, OSC sequences (title sets, hyperlinks), and lone two-byte escapes.
// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// What is left once the escapes are gone: BEL, backspace, form feed, a stray ESC. Tab and newline are text.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// A progress bar redraws one line with \r, only the last frame was ever on screen. An empty trailing frame is a
// carriage return the writer used to park the cursor, not an erase, so the last frame with anything in it wins.
const lastFrame = (line: string): string => line.split("\r").findLast((frame) => frame !== "") ?? "";

export const plainText = (output: string): string => output.replace(ANSI, "").split("\n").map(lastFrame).join("\n").replace(CONTROL, "");
