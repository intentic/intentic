// Shared text shapes and size accounting for the dependency-free cleaner stages.
import * as util from "node:util";

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

// What of a multi-line value masks on its own, to the anonymous mask: each line, and, where the value reads as a dotenv
// (a whole .env kept as one secret), each entry's value too, since `echo "$KEY"` after sourcing it prints the value
// without its `KEY=` or its quotes. Callers apply the length floor. Shared by the terminal and the tools' masking.
export const multilineParts = (value) => {
    if (!value.includes("\n")) {
        return [];
    }
    const lines = value.split("\n");
    let entries = [];
    try {
        entries = Object.values(util.parseEnv(value));
    } catch {
        // allow(silent-catch): text that is not a dotenv still masks line by line.
    }
    return [...lines, ...entries.flatMap((entry) => entry.split("\n"))];
};

// A command line as the shell splits it, for the stages that read what a command ran (test-digest.mjs).

// Words that open a compound command, a group or a negation: a line holding one is not split here.
const COMPOUND = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "coproc", "{", "}", "[[", "!"]);

// A double-quoted run from its opening quote: where it ends and what the shell reads in it. Undefined when it is
// unclosed or runs a command (`$(…)`, backticks), whose own quotes this does not follow.
const doubleQuoted = (line, start) => {
    let value = "";
    for (let index = start + 1; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            return { end: index, value };
        }
        if (character === "`" || (character === "$" && line[index + 1] === "(")) {
            return undefined;
        }
        index += character === "\\" && index + 1 < line.length ? 1 : 0;
        value += line[index];
    }
    return undefined;
};

// What the shell reads at a quote or a backslash: the text as written, its value, and the index of its last character.
// Undefined where the quote is unclosed or runs a command.
const quotedAt = (line, index) => {
    const character = line[index];
    if (character === "\\") {
        const next = line[index + 1];
        return next === "\n" ? { raw: "", value: "", end: index + 1 } : { raw: line.slice(index, index + 2), value: next ?? "", end: index + 1 };
    }
    if (character === '"') {
        const quoted = doubleQuoted(line, index);
        return quoted === undefined ? undefined : { raw: line.slice(index, quoted.end + 1), value: quoted.value, end: quoted.end };
    }
    const end = line.indexOf("'", index + 1);
    return end === -1 ? undefined : { raw: line.slice(index, end + 1), value: line.slice(index + 1, end), end };
};

// The operator at `index`: one that ends a command (`&&`, `||`, `;`, `&`, a newline) or a pipeline's stage (`|`, `|&`),
// and how many characters it spans; undefined for none. The `&` of `2>&1` and `&>` and the `|` of `>|` belong to their
// redirection (`redirecting`: the word so far ends in `<` or `>`).
const operatorAt = (line, index, redirecting) => {
    const character = line[index];
    const next = line[index + 1];
    if ((character === "&" || character === "|") && next === character) {
        return { ends: "command", op: `${character}${character}`, length: 2 };
    }
    if (character === ";" || character === "\n" || (character === "&" && !redirecting && next !== ">")) {
        return { ends: "command", op: character, length: 1 };
    }
    return character === "|" && !redirecting ? { ends: "stage", length: next === "&" ? 2 : 1 } : undefined;
};

// The commands a line splits into, built a character at a time: words into stages, stages into commands, each command
// with the operator before it.
const commandsBuilder = () => {
    const commands = [];
    let after = "";
    let stages = [];
    let words = [];
    let word;
    const endWord = () => {
        words.push(...(word === undefined ? [] : [word]));
        word = undefined;
    };
    const endStage = () => {
        endWord();
        stages.push(...(words.length === 0 ? [] : [words]));
        words = [];
    };
    return {
        inWord: () => word !== undefined,
        redirecting: () => word !== undefined && /[<>]$/.test(word.raw),
        add: (raw, value = raw) => {
            word = { raw: `${word?.raw ?? ""}${raw}`, value: `${word?.value ?? ""}${value}` };
        },
        endWord,
        endStage,
        endCommand: (operator) => {
            endStage();
            commands.push(...(stages.length === 0 ? [] : [{ after, stages }]));
            stages = [];
            after = operator;
        },
        commands,
    };
};

// One step of the split at `index`: what it adds to `built`, and the index of the last character it read; undefined
// where the line holds what this does not split.
const stepAt = (line, index, built) => {
    const character = line[index];
    if (/[`()]/.test(character) || line.startsWith("<<", index)) {
        return undefined;
    }
    if (/['"\\]/.test(character)) {
        const quoted = quotedAt(line, index);
        built.add(quoted?.raw ?? "", quoted?.value);
        return quoted?.end;
    }
    if (character === "#" && !built.inWord()) {
        const end = line.indexOf("\n", index);
        return end === -1 ? line.length : end - 1;
    }
    const operator = operatorAt(line, index, built.redirecting());
    if (operator !== undefined) {
        (operator.ends === "command" ? built.endCommand : built.endStage)(operator.op);
        return index + operator.length - 1;
    }
    if (/\s/.test(character)) {
        built.endWord();
    } else {
        built.add(character);
    }
    return index;
};

/**
 * A command line's top-level commands, split at `&&`, `||`, `;`, `&` and newlines: each with the operator before it
 * and its pipeline's stages, each stage its words as written (`raw`, quotes kept) and as the shell reads them
 * (`value`). Undefined for anything it cannot split safely: a heredoc or here-string, a subshell, command or process
 * substitution, a group or compound command, an unclosed quote.
 */
export const shellCommands = (line) => {
    const built = commandsBuilder();
    for (let index = 0; index < line.length; index += 1) {
        const last = stepAt(line, index, built);
        if (last === undefined) {
            return undefined;
        }
        index = last;
    }
    built.endCommand("");
    return built.commands.some((command) => command.stages.some((stage) => COMPOUND.has(stage[0]?.value ?? ""))) ? undefined : built.commands;
};
