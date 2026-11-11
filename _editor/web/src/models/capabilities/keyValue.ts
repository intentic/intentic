// A `keyValue` field's rows and the `KEY=VALUE` text they are stored as: the same block a pasted textarea held, read
// the way the sandbox reads it (runtimes/acp/acp-spawn.ts `parseEnvBlock`), so a card switched to rows stores what it
// always did. Plain functions; the row editor is parts/capabilities/KeyValueField.vue.

export interface KeyValueRow {
    readonly name: string;
    readonly value: string;
}

// What a shell and the sandbox's reader both take as a variable's name.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// One row per `KEY=VALUE` line; blank lines and `#` comments are skipped, and a value keeps everything after the first
// `=`, as the sandbox reads it.
export const parseKeyValues = (text: string | undefined): KeyValueRow[] =>
    (text ?? ``)
        .split(`\n`)
        .map((line) => line.trim())
        .filter((line) => line !== `` && !line.startsWith(`#`) && line.indexOf(`=`) > 0)
        .map((line) => {
            const eq = line.indexOf(`=`);
            return { name: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() };
        });

// The text the rows are stored as. A row without a name is not written: there is nothing the sandbox could set from it.
export const keyValueText = (rows: readonly KeyValueRow[]): string =>
    rows
        .filter((row) => row.name.trim() !== ``)
        .map((row) => `${row.name.trim()}=${row.value.trim()}`)
        .join(`\n`);

// Whether a row's name is one the sandbox can set; an empty one is not refused here (it is simply not stored).
export const keyNameValid = (name: string): boolean => name.trim() === `` || NAME_RE.test(name.trim());

// A paste into a row that holds more than one line, or a `KEY=VALUE` pair, read as rows to put in that row's place;
// undefined for an ordinary paste of a name.
export const pastedRows = (text: string): KeyValueRow[] | undefined => {
    if (!text.includes(`\n`) && !text.includes(`=`)) {
        return undefined;
    }
    const rows = parseKeyValues(text.replace(/^\s*export\s+/gmu, ``));
    return rows.length === 0 ? undefined : rows;
};
