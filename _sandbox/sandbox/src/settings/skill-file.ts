/* READING AND WRITING ONE SKILL.md, the frontmatter half, in one place.
 *
 * A skill is a markdown file whose leading `---` block declares the two things the model reads before deciding
 * whether to open the rest: `name` and `description`. Everything else in the file is instructions. The daemon
 * has to do both directions: it COMPOSES that block for a skill the owner writes (so a saved skill can never be
 * one the loader skips over), and it PARSES it for every skill it merely found, the ones inside extension
 * checkouts and plugin repos, which it does not own and must describe as their authors wrote them.
 *
 * Deliberately not a YAML dependency. The block this reads is two known keys written by a tool or by this file,
 * and the failure mode of a real parser here is worse than the failure mode of ignoring a line: a skill whose
 * frontmatter this cannot understand still lists, under its directory name, with an empty description, visibly
 * incomplete rather than absent from a list whose whole promise is that it shows everything. */

const FENCE = "---";

// Values that would not survive as a YAML plain scalar. `: ` and ` #` change the meaning of the line; a leading
// indicator character changes what kind of node it is. Anything else is written bare, the way every skill file
// in this repo already writes it.
const needsQuoting = (value: string): boolean => value.includes(": ") || value.includes(" #") || /^[-?:,[\]{}#&*!|>'"%@`]/.test(value);

// One frontmatter value, on one line. Newlines are collapsed rather than folded: a description is a sentence the
// model reads, multi-line YAML scalars have three spellings that differ in whitespace handling, and none of that
// is worth the chance of writing a block the loader reads differently than intended.
const yamlValue = (value: string): string => {
    const flat = value.replace(/\s+/g, " ").trim();
    return needsQuoting(flat) ? `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : flat;
};

// The document a saved skill becomes: the declared block, then the instructions as written. The body's own
// leading blank lines are dropped so re-saving an unchanged skill is byte-identical.
export const skillDocument = (name: string, description: string, body: string): string =>
    `${FENCE}\nname: ${yamlValue(name)}\ndescription: ${yamlValue(description)}\n${FENCE}\n\n${body.replace(/^\n+/, "").trimEnd()}\n`;

const unquote = (value: string): string => {
    const trimmed = value.trim();
    if ((trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) || (trimmed.startsWith(`'`) && trimmed.endsWith(`'`))) {
        return trimmed.slice(1, -1).replace(/\\"/g, `"`).replace(/\\\\/g, `\\`);
    }
    return trimmed;
};

export interface ParsedSkill {
    // Absent when the file declares no frontmatter at all, or none this can read, callers fall back to the
    // directory name, which is what the loader itself keys the skill by.
    readonly name?: string;
    readonly description?: string;
    // Everything after the frontmatter. The whole file when there is none.
    readonly body: string;
}

/* Split a SKILL.md into its declared fields and its instructions.
 *
 * A continuation line, indented, with no `key:` of its own, appends to the value above it, which is how a long
 * description written by hand or by another tool arrives. Unknown keys are skipped rather than collected: the two
 * this reads are the two anything downstream uses, and a bag of the rest would be a shape nothing consumes. */
export const parseSkillFile = (text: string): ParsedSkill => {
    const lines = text.split("\n");
    if (lines[0]?.trim() !== FENCE) {
        return { body: text };
    }
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
    if (close === -1) {
        return { body: text };
    }
    const fields: Record<string, string> = {};
    let last: string | undefined;
    for (const line of lines.slice(1, close)) {
        const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (match?.[1] !== undefined) {
            last = match[1];
            fields[last] = match[2] ?? "";
            continue;
        }
        // A continuation only continues something: an indented line before any key belongs to no field.
        if (last !== undefined && line.trim() !== "") {
            fields[last] = `${fields[last] ?? ""} ${line.trim()}`;
        }
    }
    const declared = fields[`name`];
    const stated = fields[`description`];
    const name = declared === undefined ? undefined : unquote(declared);
    const description = stated === undefined ? undefined : unquote(stated);
    return {
        ...(name !== undefined && name !== "" ? { name } : {}),
        ...(description !== undefined && description !== "" ? { description } : {}),
        body: lines
            .slice(close + 1)
            .join("\n")
            .replace(/^\n+/, ""),
    };
};
