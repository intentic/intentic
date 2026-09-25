import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isMissing } from "@intentic/base/errors";
import { opt } from "./opt.js";

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

// The frontmatter's lines as fields. An indented continuation line with no key of its own appends to the value above it.
const frontmatterFields = (lines: readonly string[]): Record<string, string> => {
    const fields: Record<string, string> = {};
    let last: string | undefined;
    for (const line of lines) {
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
    return fields;
};

// A declared field's value, unquoted; undefined when it is absent or empty.
const declaredField = (fields: Readonly<Record<string, string>>, key: string): string | undefined => {
    const raw = fields[key];
    const value = raw === undefined ? undefined : unquote(raw);
    return value === "" ? undefined : value;
};

// Splits a SKILL.md into its declared fields and its instructions; unknown keys are skipped since only `name` and
// `description` are ever used.
export const parseSkillFile = (text: string): ParsedSkill => {
    const lines = text.split("\n");
    if (lines[0]?.trim() !== FENCE) {
        return { body: text };
    }
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
    if (close === -1) {
        return { body: text };
    }
    const fields = frontmatterFields(lines.slice(1, close));
    return {
        ...opt("name", declaredField(fields, "name")),
        ...opt("description", declaredField(fields, "description")),
        body: lines
            .slice(close + 1)
            .join("\n")
            .replace(/^\n+/, ""),
    };
};

// A skill is a folder holding this file, named by the folder whatever its frontmatter declares: the loader keys it so.
export const SKILL_FILE = "SKILL.md";

export interface FoundSkill {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

// The folders directly under a skills directory, in name order; `throw` is for a caller that sweeps whatever it omits.
export const skillFolderNames = async (dir: string, unlistable: "none" | "throw" = "none"): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
        if (unlistable === "throw" && !isMissing(error)) {
            throw error;
        }
        // allow(silent-catch): an absent folder lists none; so does an unreadable one for a caller that only shows what it finds
        return [];
    });
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted((a, b) => a.localeCompare(b));
};

// Every skill under `dir` in name order, each file read through `read`; a folder whose file reads as undefined is skipped.
export const scanSkillFolders = async (
    dir: string,
    read: (path: string) => Promise<string | undefined>,
    unlistable: "none" | "throw" = "none",
): Promise<FoundSkill[]> => {
    const found: FoundSkill[] = [];
    for (const name of await skillFolderNames(dir, unlistable)) {
        const text = await read(join(dir, name, SKILL_FILE));
        if (text !== undefined) {
            const parsed = parseSkillFile(text);
            found.push({ name, description: parsed.description ?? "", body: parsed.body });
        }
    }
    return found;
};
