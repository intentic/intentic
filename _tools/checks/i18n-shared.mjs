#!/usr/bin/env node
// The editor catalog's `shared.*` section holds nouns, and states a thing is in, that every feature says with one
// meaning (docs/architecture/languages.md). Verbs go to the kit's `ui.action.*`; a phrase goes to the feature whose
// sentence it belongs to. The rule itself, and why each shape is refused, is `lib/shared-nouns.mjs`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCatalog } from "./lib/catalog.mjs";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root, subjectScope } from "./lib/repo.mjs";
import { sharedFindings } from "./lib/shared-nouns.mjs";

const EDITOR = "_editor/web/src/app/i18n/locales/en.json";
const KIT = "_editor/ui/src/i18n/locales/en.json";

// A shared message that trips the rule and is right where it stands, with the reason. A catalog is JSON, so the
// `// allow(i18n-shared): …` pragma has nowhere to sit; this is its place. An entry that stops excusing anything is
// itself a finding, so the list cannot outlive what it excuses.
const ALLOWED = {
    "shared.needs": "the awaiting state's name (Needs you): the reader is the only `you` it can mean, so the board, the switcher and the menu say it the same",
};

const scope = subjectScope();
if (scope !== undefined && !scope.has(EDITOR) && !scope.has(KIT)) {
    console.log("i18n shared: no catalog in scope");
    process.exit();
}

const read = (path) => {
    const { tree, problem } = parseCatalog(path, readFileSync(join(root, path), "utf8"));
    if (problem !== undefined) {
        cannotMeasure(problem);
    }
    return tree;
};
const editor = read(EDITOR);
const actions = Object.values(read(KIT).action ?? {}).filter((message) => !(message instanceof Object));
if (!(editor.shared instanceof Object)) {
    cannotMeasure(`${EDITOR}: no \`shared\` section to judge`);
}

finish(
    [[`${EDITOR}: a shared.* message that is not a noun phrase (move a verb to ui.action.*, a phrase to its feature)`, sharedFindings(editor.shared, actions, ALLOWED)]],
    [`i18n shared: ${Object.keys(editor.shared).length} shared.* messages, each a noun phrase or allowed with a reason`],
);
