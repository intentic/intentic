// Shared text shapes and size accounting for the dependency-free cleaner stages.

// CSI sequences, OSC sequences (title sets, hyperlinks), and lone two-byte escapes; always stripped as noise.
export const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// A spinner/progress bar redraws one line with \r: keep only the final frame. Always applied as noise.
export const collapseCr = (line) => {
    const frames = line.split("\r");
    for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i] !== "") {
            return frames[i];
        }
    }
    return "";
};

// Matches the command word itself, not a filename containing it, even through a launcher's quoting. Lookbehind only
// excludes being the tail of a path or identifier; `/` stays in so `/usr/bin/pnpm` still matches.
export const invocation = (word) => new RegExp(String.raw`(?<![\w.\-/])(?:${word})(?![\w.-])`);

// Weight of a line array joined with newlines, without building the string each stage.
export const bodyBytes = (lines) => (lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.length, 0) + lines.length - 1);

// Shared priority signals: template folding never consumes these; truncation spends its reserved space on them first.
export const IMPORTANT = /error|fatal|panic|fail|exception|traceback|warn|^\s*at |^\s+File "|\bsummary\b/i;
