import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { byteName, escapeFor, isBinaryPath, isForbiddenByte } from "@intentic/constants/control-bytes";

// The byte scan every edit gets, in every repository: a tool call's JSON spells the escape `\u0000` as the byte itself,
// so one missing backslash writes the very byte the escape exists to avoid, and every later Read renders it as nothing.

// Enough to send someone to every one of them; a file with more has a different problem.
const MAX_REPORTED = 10;

const run = promisify(execFile);

// Ignored files (logs, caches, bytecode) are nobody's source; a failed ask reads as not ignored, the stricter answer.
const ignored = (file: string): Promise<boolean> =>
    run("git", ["check-ignore", "-q", file], { cwd: dirname(file) }).then(
        () => true,
        () => false,
    );

interface Finding {
    readonly line: number;
    readonly column: number;
    readonly byte: number;
}

const findingsIn = (content: Uint8Array): Finding[] => {
    const findings: Finding[] = [];
    const text = Buffer.from(content);
    for (let at = 0; at < content.length && findings.length < MAX_REPORTED; at++) {
        const byte = content[at];
        if (byte === undefined || !isForbiddenByte(byte)) {
            continue;
        }
        const upto = text.subarray(0, at).toString("utf8");
        findings.push({ line: upto.split("\n").length, column: upto.length - upto.lastIndexOf("\n"), byte });
    }
    return findings;
};

const messageOf = (relative: string, how: string, findings: readonly Finding[]): string =>
    [
        `${findings.length} literal control byte${findings.length === 1 ? "" : "s"} in ${relative} after ${how}:`,
        ...findings.map(({ line, column, byte }) => `  ${relative}:${line}:${column}  literal ${byteName(byte)}, write it as ${escapeFor(byte)}`),
        `Git and every diff viewer read this file as binary, and the push gate refuses it. A tool call carries its arguments ` +
            `as JSON, where \\u0000 IS the byte: writing the six characters needs \\\\u0000 in the argument. Rewrite each as its ` +
            `escape (the same code point at runtime), then read the file back; a Read shows a literal control byte as nothing.`,
    ].join("\n");

export interface EditBytesDeps {
    // Where the daemon reads the file the agent named (an isolated turn's own copy).
    readonly onDisk: (file: string) => string;
    // The name the model is told, relative to the tree; undefined for a file outside it, which is nobody's source.
    readonly relative: (file: string) => string | undefined;
}

// Same signature as every edit reviewer: undefined means nothing to say, and a file it cannot read says nothing.
export const editBytesReviewer =
    (deps: EditBytesDeps) =>
    async (file: string, how: string): Promise<string | undefined> => {
        const relative = deps.relative(file);
        if (relative === undefined || isBinaryPath(file)) {
            return undefined;
        }
        const onDisk = deps.onDisk(file);
        const content = await readFile(onDisk).catch(() => undefined);
        if (content === undefined || !content.some(isForbiddenByte) || (await ignored(onDisk))) {
            return undefined;
        }
        return messageOf(relative, how, findingsIn(content));
    };
