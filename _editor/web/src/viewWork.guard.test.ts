import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { allowedAt } from "@intentic/constants/allow";

// Refuses work state kept in a view. `useAsyncAction()` and `useConcurrentActions()` (@intentic/ui/async) hold a
// busy flag and a notice per caller, so called in a component's setup or a composable that runs per component, they
// die with the view while the work they track runs on: the reader who opens another view and comes back finds the
// button offered again over work still running, and its failure gone. Work a person starts belongs to what it is
// about, in the operations ledger (workbench/operations/operations.ts: useOperation, useOperations).
// Still allowed: a module-level runner (column 0 of a .ts, or a .vue's plain <script>), and one held through the sandbox
// scope (`sandboxShallowRef(() => useAsyncAction())`), since both outlive every view. Anything else that is truly the
// view's own carries `// allow(view-work): <why it dies with the view>` on the line or the comment block above it.

const SRC = import.meta.dirname;
const CHECK = `view-work`;

const SETUP_SCRIPT = /<script[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script>/g;
const PLAIN_SCRIPT = /<script(?![^>]*\bsetup\b)[^>]*>([\s\S]*?)<\/script>/g;

interface Source {
    readonly path: string;
    /** Code that runs once per module. */
    readonly module: string;
    /** Code that runs once per view: a component's <script setup>. */
    readonly view: string;
}

const sources = (): Source[] => {
    const found: Source[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (full !== join(SRC, `testing`)) {
                    walk(full);
                }
                continue;
            }
            const path = relative(SRC, full).replaceAll(`\\`, `/`);
            const text = () => readFileSync(full, `utf8`);
            if (entry.name.endsWith(`.vue`)) {
                const whole = text();
                const blocks = (pattern: RegExp): string => [...whole.matchAll(pattern)].map((match) => match[1] ?? ``).join(`\n`);
                found.push({ path, module: blocks(PLAIN_SCRIPT), view: blocks(SETUP_SCRIPT) });
            } else if (entry.name.endsWith(`.ts`) && !entry.name.endsWith(`.test.ts`) && !entry.name.endsWith(`.d.ts`)) {
                found.push({ path, module: text(), view: `` });
            }
        }
    };
    walk(SRC);
    return found;
};

const CALL = /\b(?:useAsyncAction|useConcurrentActions)\s*\(/;
// Held beyond any view: declared at module level, or handed to the sandbox scope on the same line.
const MODULE_DECLARATION = /^(?:export )?(?:const|let)\s/;
const SCOPED = /\bsandbox(?:Ref|ShallowRef|Value)\s*\(/;

const findings = (path: string, text: string, inView: boolean): string[] => {
    const lines = text.split(`\n`);
    return lines.flatMap((line, at) => {
        if (!CALL.test(line)) {
            return [];
        }
        const kept = SCOPED.test(line) || (!inView && MODULE_DECLARATION.test(line));
        return kept || allowedAt(lines, at + 1, CHECK) ? [] : [`${path}: ${line.trim()}`];
    });
};

const scanned = sources();

test(`the guard is actually looking at the editor`, () => {
    expect(scanned.length).toBeGreaterThanOrEqual(900);
});

// A failure names a busy flag and a notice that die with their view. Move the work onto useOperation (keyed by what it
// is about, so any view naming that key reads the same run); or, when the view really is the work's whole life (a
// live preview, a form's own validation), say so with `// allow(view-work): <why>`.
test(`work a person starts is kept beyond the view that started it`, () => {
    expect(scanned.flatMap(({ path, module, view }) => [...findings(path, module, false), ...findings(path, view, true)])).toEqual([]);
});
