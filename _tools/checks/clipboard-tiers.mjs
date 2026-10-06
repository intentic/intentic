#!/usr/bin/env node
// ONE DOOR TO THE CLIPBOARD, AND IT IS THE KIT'S. Chrome's async clipboard refuses a write from a document that does not
// have focus, with nothing said: a press in a popped-out window, written through the opener's `navigator.clipboard`,
// copies nothing. The kit's `clipboardOf(element)` asks the pressed element's own window, and `writeClipboard`,
// `readClipboard` and `useCopied` (`@intentic/ui/clipboard`; `clipboardOf` from `@intentic/extension-ui` in an
// extension) build on it, never rejecting and with one "Copied" duration.
//
// Refused in the editor's surfaces (the web app, the desktop shell, the share view) and every extension, outside tests:
// `navigator.clipboard`, optional-chained or not. A site that is right to do it says why with
// `// allow(clipboard-tiers): <reason>`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clipboardCalls } from "./lib/clipboard-calls.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles, TEST_FILE } from "./lib/repo.mjs";

const SURFACES = /^(?:_editor\/(?:web|desktop-app|share-view)\/src|_extensions\/[^/]+\/src)\//;
const SOURCE = /\.(?:ts|mts|tsx|js|mjs|vue)$/;
const FIXTURE = /\/(?:testing|fixtures?)\/|\.testing\.ts$|\/testing\.ts$/;

const subjects = subjectFiles().filter((path) => SURFACES.test(path) && SOURCE.test(path) && !TEST_FILE.test(path) && !FIXTURE.test(path));
const found = subjects.flatMap((path) => clipboardCalls(readFileSync(join(root, path), `utf8`)).map(({ line, why }) => `${path}:${line}  ${why}`));

finish(
    [
        [
            `the clipboard reached directly: go through the kit (@intentic/ui/clipboard: writeClipboard, readClipboard, useCopied, clipboardOf; clipboardOf from @intentic/extension-ui in an extension), or say at the site why it must stay with \`// allow(clipboard-tiers): <reason>\``,
            found,
        ],
    ],
    [`${subjects.length} files in the editor's surfaces and the extensions: every clipboard call goes through the kit`],
);
