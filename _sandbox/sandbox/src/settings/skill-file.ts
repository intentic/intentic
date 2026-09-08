// Reads and writes a SKILL.md's frontmatter (`name`, `description`); composes it for a skill the daemon owns, parses it
// for one merely found (extension checkouts, plugin repos). Not a YAML dependency on purpose: an unreadable frontmatter
// must degrade to an incomplete listing, never a missing one.

const FENCE = "---";

// Values that would not survive as a YAML plain scalar: `: ` or ` #` mid-string, or a leading indicator character
// change what the line means.
const needsQuoting = (value: string): boolean => value.includes(": ") || value.includes(" #") || /^[-?:,[\]{}#&*!|>'"%@`]/.test(value);

// Flattens a value onto one line rather than folding it: YAML's multi-line scalar forms differ in whitespace handling,
// not worth risking the loader reading the block differently than intended.
const yamlValue = (value: string): string => {
    const flat = value.replace(/\s+/g, " ").trim();
    return needsQuoting(flat) ? `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : flat;
};

// The document a saved skill becomes: the declared block, then the instructions as written. Leading blank lines in the
// body are dropped, so resaving an unchanged skill is byte-identical.
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
    // Absent with no readable frontmatter; callers fall back to the directory name, the loader's own key.
    readonly name?: string;
    readonly description?: string;
    // Everything after the frontmatter; the whole file when there is none.
    readonly body: string;
}

// Splits a SKILL.md into its declared fields and its instructions. An indented continuation line with no key of its own
// appends to the value above it; unknown keys are skipped since only `name` and `description` are ever used.
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
