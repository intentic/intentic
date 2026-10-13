import type { TranscriptTool } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// What a tool call is called for someone who doesn't write code: the act in plain words ("Reading a file", "Running
// checks") instead of the tool's own name and arguments ("Bash cd /work && rg ..."). Read wherever a call or the
// agent's current step is named while the audience is a maker (useAudience); a developer keeps the tool's own words.
// Pure apart from `t`, and never says more than it knows: a shell line it cannot place is "Running a task", not a guess.

export interface ToolWordsInput {
    // The tool as the agent called it ("Bash") or as the transcript names it ("bash", "Browser click", "mcp__x__y").
    readonly name: string | undefined;
    // What it reached for: a file, a command, a URL.
    readonly target?: string | undefined;
    readonly category?: TranscriptTool["category"] | undefined;
}

type Family = `command` | `read` | `edit` | `search` | `webSearch` | `webPage` | `browser` | `helper` | `ask` | `plan` | `page` | `connected` | `other`;

// Tools by their lowercased name; whatever is not here is placed by its shape (familyOf) and then by its category.
const NAMED_FAMILIES = new Map<string, Family>([
    [`bash`, `command`],
    [`bashoutput`, `command`],
    [`shell`, `command`],
    [`run_command`, `command`],
    [`read`, `read`],
    [`edit`, `edit`],
    [`write`, `edit`],
    [`multiedit`, `edit`],
    [`notebookedit`, `edit`],
    [`grep`, `search`],
    [`glob`, `search`],
    [`ls`, `search`],
    [`list`, `search`],
    [`find`, `search`],
    [`websearch`, `webSearch`],
    [`webfetch`, `webPage`],
    [`agent`, `helper`],
    [`task`, `helper`],
    [`askuserquestion`, `ask`],
    [`todowrite`, `plan`],
    [`taskcreate`, `plan`],
    [`taskupdate`, `plan`],
    [`tasklist`, `plan`],
    [`taskget`, `plan`],
    [`show page`, `page`],
    [`ask on a page`, `page`],
]);

const CATEGORY_FAMILIES = new Map<TranscriptTool["category"], Family>([
    [`execute`, `command`],
    [`read`, `read`],
    [`edit`, `edit`],
    [`delete`, `edit`],
    [`move`, `edit`],
    [`search`, `search`],
    [`fetch`, `webPage`],
]);

// Programs that only look: for code, or at what a file or folder holds. A line made of these alone is "looking through".
const LOOKING = new Set([
    `iq`, `grep`, `rg`, `ag`, `ack`, `find`, `fd`, `fdfind`, `locate`, `ls`, `tree`, `cat`, `sed`, `head`, `tail`, `less`, `more`, `bat`, `awk`,
    `wc`, `stat`, `file`, `du`, `pwd`, `echo`, `sort`, `uniq`, `cut`, `jq`, `diff`, `readlink`, `which`, `test`, `[`,
]);
// Programs that run a project's own checks.
const CHECKING = new Set([`vitest`, `jest`, `pytest`, `tsc`, `eslint`, `oxlint`, `biome`, `prettier`, `cargo`, `go`, `mocha`, `playwright`, `lsp`]);
const RUNNERS = new Set([`bunx`, `npx`, `pnpx`]);
const PACKAGE_MANAGERS = new Set([`npm`, `pnpm`, `yarn`, `bun`, `pip`, `pip3`, `uv`, `cargo`, `apt`, `apt-get`, `brew`]);

const statementsOf = (command: string): string[] =>
    command
        .split(/&&|\|\||;|\n/)
        .map((statement) => statement.trim())
        .filter((statement) => statement !== ``);

// The program a statement starts: past an env prefix, and without the path it was called by.
const headOf = (statement: string): string => {
    const words = statement.split(/\s+/).filter((candidate) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate));
    // `bunx vitest` / `npx tsc` run the program after them.
    const word = (RUNNERS.has(words[0] ?? ``) ? words[1] : words[0]) ?? ``;
    return word.split(`/`).pop() ?? word;
};

type CommandKind = `lookThrough` | `checks` | `install` | `command`;

const commandKind = (command: string | undefined): CommandKind => {
    if (command === undefined) {
        return `command`;
    }
    // `cd` only moves; it says nothing about what the line did there.
    const statements = statementsOf(command).filter((statement) => headOf(statement) !== `cd`);
    if (statements.length === 0) {
        return `command`;
    }
    const heads = statements.map(headOf);
    if (statements.some((statement, index) => PACKAGE_MANAGERS.has(heads[index]!) && /\b(?:install|add|i|ci|sync)\b/.test(statement))) {
        return `install`;
    }
    if (
        statements.some(
            (statement, index) =>
                CHECKING.has(heads[index]!) ||
                (PACKAGE_MANAGERS.has(heads[index]!) && /\b(?:test|lint|typecheck|check|build|tsc)\b/.test(statement)),
        )
    ) {
        return `checks`;
    }
    return heads.every((head) => LOOKING.has(head)) ? `lookThrough` : `command`;
};

// A file's own name, when the target looks like a path and not a sentence or a pattern; never the directories above it,
// which are the part a maker has no use for.
const fileNameOf = (target: string | undefined): string | undefined => {
    const clean = target?.trim();
    if (clean === undefined || clean === `` || /\s|[*?{}]/.test(clean)) {
        return undefined;
    }
    const name = clean.split(/[\\/]/).findLast(Boolean);
    return name !== undefined && (clean.includes(`/`) || /\.[A-Za-z0-9]+$/.test(name)) ? name : undefined;
};

const familyOf = ({ name, category }: ToolWordsInput): Family => {
    const lower = (name ?? ``).toLowerCase();
    const named = NAMED_FAMILIES.get(lower);
    if (named !== undefined) {
        return named;
    }
    if (lower.startsWith(`browser `)) {
        return `browser`;
    }
    if (/^mcp__(?:subagents|custom-user-tools)__/.test(lower)) {
        return `helper`;
    }
    if (lower.startsWith(`mcp__`)) {
        return `connected`;
    }
    return (lower.includes(`search`) ? `search` : undefined) ?? (category === undefined ? undefined : CATEGORY_FAMILIES.get(category)) ?? `other`;
};

/**
 * The call as a short phrase in plain words. `file` says whether a file's name belongs in the phrase ("Reading app.ts"):
 * the live status line wants it, while a card that shows the path beside the phrase does not.
 */
export const plainToolWords = (input: ToolWordsInput, { file = true }: { readonly file?: boolean } = {}): string => {
    switch (familyOf(input)) {
        case `command`:
            return t(`chat.toolWords.${commandKind(input.target)}`);
        case `read`: {
            const named = file ? fileNameOf(input.target) : undefined;
            return named === undefined ? t(`chat.toolWords.read`) : t(`chat.toolWords.readNamed`, { file: named });
        }
        case `edit`: {
            const named = file ? fileNameOf(input.target) : undefined;
            return named === undefined ? t(`chat.toolWords.edit`) : t(`chat.toolWords.editNamed`, { file: named });
        }
        case `search`:
            return t(`chat.toolWords.search`);
        case `webSearch`:
            return t(`chat.toolWords.webSearch`);
        case `webPage`:
            return t(`chat.toolWords.webPage`);
        case `browser`:
            return t(`chat.toolWords.browser`);
        case `helper`:
            return t(`chat.toolWords.helper`);
        case `ask`:
            return t(`chat.toolWords.ask`);
        case `plan`:
            return t(`chat.toolWords.plan`);
        case `page`:
            return t(`chat.toolWords.page`);
        case `connected`:
            return t(`chat.toolWords.connected`);
        default:
            return t(`chat.toolWords.other`);
    }
};
