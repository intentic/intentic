import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fieldNotes } from "@intentic/agent-context/field-notes";
import { workspaceMapNote } from "@intentic/agent-context/workspace-map";
import { readOptions, saveOptions, type Options } from "./features.js";
import { dataDir, type Env, fieldNotesFile, type HookInput, projectDir, runHook } from "./hook-io.js";
import { claimIfDue, onPath, pluginFile, projectSlug, startDetached } from "./runtime.js";
import { armsOf, type Mechanism, measuredArms, recordSession, sends, type SessionRow } from "./sessions.js";
import { sweepIfDue } from "./shadows.js";

// SessionStart: what a session is told as it opens (the project map, this project's field notes, the iq teaching), which
// arm it drew for each, and the background work a session starts (document shadows, iq's transcript ingest). The same
// notes the sandbox composes into its turns, from the same code, delivered as this hook's additional context.

// The field-notes budget the sandbox defaults to, in characters: the ranked brief is cut to whole sections under it.
const NOTES_BUDGET = 4_000;

// A notice about the setup (iq missing, a notes file that cannot be read) is said once a day, not on every session.
const NOTICE_EVERY_MS = 24 * 60 * 60_000;

// A new conversation (a launch or a /clear) opens with the notes and is measured; a compaction keeps the session but
// loses what rode in, so it is told again without being counted twice; a resume or a fork already carries them.
const TOLD_ON = new Set(["startup", "clear", "compact"]);
const COUNTED_ON = new Set(["startup", "clear"]);

interface Composed {
    readonly context: string[];
    readonly row: Pick<SessionRow, "arms" | "sent" | "notesRevision">;
    readonly notices: string[];
}

const compose = (options: Options, input: HookInput, project: string, arms: SessionRow["arms"], data: string, env: Env): Composed => {
    const context: string[] = [];
    const notices: string[] = [];
    const notice = (id: string, text: string): void => {
        if (claimIfDue(join(data, "notices", `${id}.stamp`), NOTICE_EVERY_MS)) {
            notices.push(text);
        }
    };
    const iq = options.iq && onPath("iq", env);
    const sent: { map?: number; notes?: number; iq?: boolean } = {};
    // What each measured mechanism had to give, worked out on both arms, so a control session is only counted as one
    // when there was something to withhold from it.
    const offered: { [K in Mechanism]?: boolean } = {};
    let notesRevision: string | undefined;
    if (options.project_map) {
        const note = workspaceMapNote({ root: project, cwd: input.cwd ?? project, exactPaths: iq ? "`iq files` or Read" : "Glob or Read" });
        offered.map = note !== undefined;
        if (note !== undefined && sends(options, arms, "map")) {
            context.push(note);
            sent.map = note.length;
        }
    }
    if (options.field_notes) {
        // Read on both arms, so a control session still names the revision it was withheld from.
        const brief = fieldNotes({
            file: fieldNotesFile(project),
            title: "Field notes for this project",
            budget: NOTES_BUDGET,
            onUnreadable: (why) => notice(`notes-${projectSlug(project)}`, `intentic: this project's field notes were not sent: ${why}. Run /intentic:field-notes to rewrite them.`),
        });
        notesRevision = brief?.revision;
        offered.notes = brief !== undefined;
        if (brief !== undefined && sends(options, arms, "notes")) {
            context.push(brief.text);
            sent.notes = brief.chars;
        }
    }
    if (options.iq) {
        if (iq) {
            const nudge = pluginFile(["generated", "iq-nudge.txt"], env);
            offered.iq = nudge !== undefined;
            if (nudge !== undefined && sends(options, arms, "iq")) {
                context.push(`## iq workspace search\n\n${nudge.trim()}`);
                sent.iq = true;
            }
            // iq's session recall reads Claude Code's own transcripts; ingest keeps its index current.
            startDetached("iq", ["sessions", "ingest"], { cwd: project, log: join(data, "iq", `${projectSlug(project)}.ingest.log`), env });
        } else {
            notice("iq-missing", "intentic: iq search is on but the `iq` CLI is not installed (`npm i -g @intentic/iq`), so nothing was taught.");
        }
    }
    return { context, row: { arms: measuredArms(arms, offered), sent, ...(notesRevision === undefined ? {} : { notesRevision }) }, notices };
};

// Values for every Bash command this session runs: where the project is (the bundled fileq keys its shadows by it) and
// whether fileq is switched on. Bash commands get no plugin variables of their own.
const exportEnv = (options: Options, project: string, env: Env): void => {
    const file = env["CLAUDE_ENV_FILE"];
    if (file === undefined || file === "") {
        return;
    }
    const quoted = `'${project.replaceAll("'", `'\\''`)}'`;
    appendFileSync(file, `export INTENTIC_PROJECT_DIR=${quoted}\nexport INTENTIC_FILEQ=${options.fileq ? "1" : "0"}\n`);
};

// The ledgers are for the report: a data directory that cannot be written costs them, never what the session is told.
const record = (what: string, write: () => void): void => {
    try {
        write();
    } catch (error) {
        process.stderr.write(`intentic: ${what} not recorded: ${error instanceof Error ? error.message : String(error)}\n`);
    }
};

export const sessionStart = (input: HookInput, env: Env = process.env): object | undefined => {
    const options = readOptions(env);
    const data = dataDir(env);
    const project = projectDir(input, env);
    const source = input.source ?? "startup";
    record("the switches", () => saveOptions(data, options));
    exportEnv(options, project, env);
    if (options.shadows && existsSync(project)) {
        sweepIfDue(data, project, env);
    }
    if (!TOLD_ON.has(source)) {
        return undefined;
    }
    const { context, row, notices } = compose(options, input, project, armsOf(options, input.session_id), data, env);
    const session = input.session_id;
    if (COUNTED_ON.has(source) && session !== undefined) {
        record("the session", () =>
            recordSession(data, {
                ts: Date.now(),
                session,
                project,
                ...(input.transcript_path === undefined ? {} : { transcript: input.transcript_path }),
                ...row,
            }),
        );
    }
    if (context.length === 0 && notices.length === 0) {
        return undefined;
    }
    return {
        ...(notices.length === 0 ? {} : { systemMessage: notices.join("\n") }),
        hookSpecificOutput: { hookEventName: "SessionStart", ...(context.length === 0 ? {} : { additionalContext: context.join("\n\n") }) },
    };
};

if (process.argv[1]?.endsWith("session-start.mjs")) {
    await runHook((input) => sessionStart(input));
}
