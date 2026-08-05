// Single-file components (.vue) hold TypeScript inside a <script> block. ast-grep has no Vue grammar and there
// is no @ast-grep/lang-vue, but the script body IS TypeScript once its template/style siblings are stripped —
// so we lift each block out and hand it to the grammar that is already loaded. The line offset puts every
// extracted symbol back on its real line in the .vue file, which is what keeps `path:line` anchors honest.

export interface ScriptBlock {
    readonly content: string;
    // Tsx only when the block declares a JSX dialect — the plain TypeScript grammar rejects JSX syntax.
    readonly lang: "ts" | "tsx";
    // Lines preceding the block's first line, added to every symbol line the parse yields.
    readonly lineOffset: number;
}

// Both blocks of the two-block form (`<script>` for module-scope exports, `<script setup>` for the component
// body) are lifted — either can hold the symbols a reader is looking for.
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

export const scriptBlocksOf = (content: string): ScriptBlock[] => {
    const blocks: ScriptBlock[] = [];
    SCRIPT_BLOCK.lastIndex = 0;
    for (let match = SCRIPT_BLOCK.exec(content); match !== null; match = SCRIPT_BLOCK.exec(content)) {
        const body = match[2]!;
        if (body.trim() === "") {
            continue;
        }
        // The body starts just past the opening tag's `>` — match[0] begins at `<script`, so its first `>` closes it.
        const bodyStart = match.index + match[0]!.indexOf(">") + 1;
        blocks.push({
            content: body,
            lang: /lang\s*=\s*["']?[jt]sx/i.test(match[1]!) ? "tsx" : "ts",
            lineOffset: content.slice(0, bodyStart).split("\n").length - 1,
        });
    }
    return blocks;
};
