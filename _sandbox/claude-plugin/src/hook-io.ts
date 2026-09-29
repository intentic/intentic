import { homedir } from "node:os";
import { join } from "node:path";

// What every hook entry shares: reading Claude Code's JSON payload, answering it, and failing open. A hook here is
// unsolicited help, so whatever goes wrong costs the help and never the session: an unreadable payload, a throw, or a
// missing data directory all answer with nothing, which Claude Code reads as "carry on unchanged".

// The environment a hook reads: the process's own when Claude Code runs it, a literal in a test.
export type Env = Readonly<Record<string, string | undefined>>;

export interface HookInput {
    readonly session_id?: string;
    readonly transcript_path?: string;
    readonly cwd?: string;
    readonly hook_event_name?: string;
    readonly source?: string;
    readonly prompt?: string;
    readonly tool_name?: string;
    readonly tool_input?: Record<string, unknown>;
    readonly tool_response?: unknown;
    readonly tool_use_id?: string;
    readonly duration_ms?: number;
}

export const readStdin = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
};

export const parseHookInput = (text: string): HookInput | undefined => {
    try {
        const value: unknown = JSON.parse(text);
        return typeof value === "object" && value !== null ? (value as HookInput) : undefined;
    } catch {
        // allow(silent-catch): a payload that is not JSON gets no answer, which Claude Code reads as "carry on unchanged".
        return undefined;
    }
};

// What a handler answers: a JSON reply, text passed through as another program printed it, or nothing.
export type HookAnswer = object | string | undefined;

// Runs one hook: the handler's answer, when it has one, is the whole of stdout. The raw payload rides along for a handler
// that hands it on to another hook program (iq's own matcher).
export const runHook = async (handle: (input: HookInput, raw: string) => Promise<HookAnswer> | HookAnswer): Promise<void> => {
    try {
        const raw = await readStdin();
        const input = parseHookInput(raw);
        if (input === undefined) {
            return;
        }
        const answer = await handle(input, raw);
        if (typeof answer === "string") {
            process.stdout.write(answer);
        } else if (answer !== undefined) {
            process.stdout.write(`${JSON.stringify(answer)}\n`);
        }
    } catch (error) {
        // Stderr from a hook that exits 0 is only shown in debug output, which is where a broken hook should be found.
        process.stderr.write(`intentic: ${error instanceof Error ? error.message : String(error)}\n`);
    }
};

// Where the plugin keeps what it measures, across sessions and updates. Claude Code hands every hook this directory;
// the fallback is its documented location, for a script started by hand.
export const dataDir = (env: Env = process.env): string =>
    env["CLAUDE_PLUGIN_DATA"] ?? join(env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "plugins", "data", "intentic-intentic");

// The project a session belongs to: the directory Claude Code was started in, which is also where transcripts are filed.
export const projectDir = (input: HookInput, env: Env = process.env): string =>
    env["CLAUDE_PROJECT_DIR"] ?? input.cwd ?? process.cwd();

// This project's field notes. Inside the project so a session reads them without a permission prompt, and so a team can
// choose to commit them; `/intentic:field-notes` writes them, the SessionStart hook reads them.
export const fieldNotesFile = (project: string): string => join(project, ".claude", "intentic", "field-notes.toon");

// Claude Code files a project's transcripts under its path with every character that is not a letter or a digit
// turned into a dash (`/work/my_app` is `-work-my-app`).
export const transcriptDir = (project: string, env: Env = process.env): string =>
    join(env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
