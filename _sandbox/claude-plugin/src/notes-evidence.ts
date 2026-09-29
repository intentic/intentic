import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readClaudeSession, type TranscriptCall, type TranscriptSession } from "@intentic/agent-context/claude-transcript";
import { redactText } from "@intentic/output-cleaners/cleaners";
import { commandSignature } from "@intentic/output-cleaners/stats";
import { fieldNotesFile, transcriptDir } from "./hook-io.js";
import { isMissing } from "./runtime.js";

// The evidence a field-notes rewrite is written from: this project's Claude Code sessions, read back and COUNTED, so the
// model writing the notes starts from how many sessions hit a thing rather than from paging through megabytes of
// transcripts itself. The sandbox's automation does the same reading with its `agents` CLI; this is its plugin
// counterpart, printed straight into /intentic:field-notes.

// The newest sessions read back; a month of steady use, and a bounded read.
const MAX_SESSIONS = 200;
// What the digest may cost the rewrite's context, in characters.
const BUDGET_CHARS = 12_000;

interface Tally {
    runs: number;
    failures: number;
    readonly sessions: Set<string>;
    readonly examples: Set<string>;
}

const tally = (map: Map<string, Tally>, key: string): Tally => {
    const found = map.get(key);
    if (found !== undefined) {
        return found;
    }
    const created: Tally = { runs: 0, failures: 0, sessions: new Set(), examples: new Set() };
    map.set(key, created);
    return created;
};

// What a call was, as a person would group it: a shell command by its verb, anything else by its tool.
const signatureOf = (call: TranscriptCall): string =>
    call.name === "Bash" && call.target !== undefined ? `\`${commandSignature(call.target) || call.target.slice(0, 40)}\`` : call.name;

// How a session opened, as the person typed it: a slash command is filed as tags (`<command-name>/x</command-name>` and
// its `<command-args>`), which say the same thing at three times the length.
export const openingOf = (prompt: string): string => {
    const name = /<command-name>([^<]*)<\/command-name>/.exec(prompt)?.[1]?.trim();
    if (name === undefined || name === "") {
        return (prompt.split("\n")[0] ?? "").slice(0, 140);
    }
    const args = /<command-args>([^<]*)<\/command-args>/.exec(prompt)?.[1]?.trim() ?? "";
    return `${name.startsWith("/") ? name : `/${name}`}${args === "" ? "" : ` ${args.slice(0, 120)}`}`;
};

// The first line that says something, cut short: "Exit code 1" alone names no trap.
const exampleOf = (text: string): string => {
    const first =
        text
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line !== "" && !/^Exit code \d+$/.test(line)) ?? text.trim();
    return first.length > 160 ? `${first.slice(0, 157)}…` : first;
};

interface Digest {
    readonly sessions: number;
    readonly from: number | undefined;
    readonly to: number | undefined;
    readonly turns: number;
    readonly calls: number;
    readonly failures: number;
    readonly failed: Map<string, Tally>;
    readonly commands: Map<string, Tally>;
    readonly edited: Map<string, Tally>;
    readonly prompts: string[];
}

// One turn's calls into the command and edited-file tallies, under the session that made them.
const tallyCalls = (calls: readonly TranscriptCall[], session: string, commands: Map<string, Tally>, edited: Map<string, Tally>): void => {
    for (const call of calls) {
        if (call.name === "Bash") {
            const entry = tally(commands, signatureOf(call));
            entry.runs += 1;
            entry.sessions.add(session);
        }
        for (const { path } of call.category === "edit" ? (call.locations ?? []) : []) {
            const entry = tally(edited, path);
            entry.runs += 1;
            entry.sessions.add(session);
        }
    }
};

export const digestOf = (sessions: readonly TranscriptSession[]): Digest => {
    const failed = new Map<string, Tally>();
    const commands = new Map<string, Tally>();
    const edited = new Map<string, Tally>();
    const prompts: string[] = [];
    let turns = 0;
    let calls = 0;
    let failures = 0;
    let from: number | undefined;
    let to: number | undefined;
    for (const [index, session] of sessions.entries()) {
        const id = session.sessionId ?? String(index);
        const first = session.turns[0];
        if (first !== undefined) {
            from = Math.min(from ?? first.at, first.at);
            to = Math.max(to ?? first.at, session.turns.at(-1)?.at ?? first.at);
            prompts.push(openingOf(first.prompt));
        }
        for (const turn of session.turns) {
            turns += 1;
            calls += turn.calls.length;
            failures += turn.failures.length;
            const byId = new Map(turn.calls.map((call) => [call.id, call]));
            tallyCalls(turn.calls, id, commands, edited);
            for (const failure of turn.failures) {
                const call = byId.get(failure.id);
                const key = call === undefined ? "a subagent's call" : signatureOf(call);
                const entry = tally(failed, key);
                entry.failures += 1;
                entry.sessions.add(id);
                if (entry.examples.size < 2) {
                    entry.examples.add(exampleOf(failure.text));
                }
                if (call?.name === "Bash") {
                    tally(commands, key).failures += 1;
                }
            }
        }
    }
    return { sessions: sessions.length, from, to, turns, calls, failures, failed, commands, edited, prompts };
};

const bySessions = (map: Map<string, Tally>): [string, Tally][] =>
    [...map.entries()].toSorted((left, right) => right[1].sessions.size - left[1].sessions.size || right[1].runs - left[1].runs);

const utcDay = (at: number | undefined): string => (at === undefined ? "?" : new Date(at).toISOString().slice(0, 10));

export const renderDigest = (digest: Digest, project: string, notesFile: string): string => {
    const head = [
        `Corpus: ${digest.sessions} sessions of this project (${utcDay(digest.from)} to ${utcDay(digest.to)}), ${digest.turns} turns, ${digest.calls} tool calls, ${digest.failures} of them failed.`,
        `Notes file: \`${notesFile}\` (read it first if it exists; this digest does not include it).`,
    ];
    const sections: [string, string[]][] = [
        [
            "Failures, by how many sessions hit them",
            bySessions(digest.failed)
                .slice(0, 25)
                .map(([key, entry]) => `- ${key}: ${entry.failures} failures in ${entry.sessions.size} sessions — e.g. ${[...entry.examples].map((text) => `"${text}"`).join("; ")}`),
        ],
        [
            "Commands run, with how often they failed",
            bySessions(digest.commands)
                .slice(0, 20)
                .map(([key, entry]) => `- ${key}: ${entry.runs} runs in ${entry.sessions.size} sessions, ${entry.failures} failed`),
        ],
        ["Files edited in the most sessions", bySessions(digest.edited).slice(0, 12).map(([path, entry]) => `- ${path}: ${entry.sessions.size} sessions`)],
        ["How recent sessions opened (first line of the first prompt)", digest.prompts.slice(0, 15).map((prompt) => `- ${prompt}`)],
    ];
    // Whole lines only, dropped from the tail of each section, so what survives the budget is still true of the corpus.
    const lines = [...head];
    let used = head.join("\n").length;
    for (const [title, items] of sections) {
        const heading = `\n### ${title}`;
        used += heading.length;
        lines.push(heading);
        for (const item of items.length === 0 ? ["- none"] : items) {
            if (used + item.length + 1 > BUDGET_CHARS) {
                lines.push("- … cut to fit");
                break;
            }
            used += item.length + 1;
            lines.push(item);
        }
    }
    return redactText(`${lines.join("\n")}\n\nTranscripts: \`${transcriptDir(project)}\` (one JSON object per line).\n`);
};

// The project's session files, newest first; a subagent's own file lives in a session's directory, not beside it.
const sessionFiles = (dir: string): string[] => {
    let names: string[];
    try {
        names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch (error) {
        // A project Claude Code has never run in has no directory yet: no sessions, not a failure.
        if (isMissing(error)) {
            return [];
        }
        throw error;
    }
    return names
        .map((name) => {
            try {
                return { path: join(dir, name), at: statSync(join(dir, name)).mtimeMs };
            } catch {
                return { path: join(dir, name), at: 0 };
            }
        })
        .toSorted((left, right) => right.at - left.at)
        .slice(0, MAX_SESSIONS)
        .map((entry) => entry.path);
};

export const notesEvidence = (project: string): string => {
    const sessions = sessionFiles(transcriptDir(project)).flatMap((file) => {
        const session = readClaudeSession(file, { root: project });
        return session === undefined || session.turns.length === 0 ? [] : [session];
    });
    return renderDigest(digestOf(sessions), project, fieldNotesFile(project));
};

if (process.argv[1]?.endsWith("notes-evidence.mjs")) {
    const at = process.argv.indexOf("--project");
    process.stdout.write(notesEvidence(at === -1 ? process.cwd() : (process.argv[at + 1] ?? process.cwd())));
}
