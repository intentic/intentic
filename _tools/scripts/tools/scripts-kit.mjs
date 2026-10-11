// THE INSTALL SCRIPTS' SHARED CODE, written once and pasted in. Every script under _site/site/public/scripts is one
// self-contained file (piped into `sh` or `iex`, run by path from a checkout, bundled into the desktop app), so nothing
// can be imported at run time. What used to be copied by hand (the output kit, the ic download, the PATH edit, the
// intentic-machine download, the code redemption) lives once under _site/site/scripts-kit/ and is materialised into
// each script between two marker lines:
//
//   # >>> generated from _site/site/scripts-kit/<name>: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
//   # <<< end of generated <name>
//
// A script names the regions it wants by carrying their markers; this fills them. The `scripts-kit` check fails when a
// region is stale, and `--fix` rewrites it. Plain file reading, no network.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";

export const root = repoRoot(import.meta.url);
export const KIT_DIR = "_site/site/scripts-kit";
export const SCRIPTS_DIR = "_site/site/public/scripts";

const OPEN = /^# >>> generated from _site\/site\/scripts-kit\/([A-Za-z0-9.-]+): edit it there, then run node _tools\/checks\/scripts-kit\.mjs --fix$/;
const openLine = (name) => `# >>> generated from ${KIT_DIR}/${name}: edit it there, then run node _tools/checks/scripts-kit.mjs --fix`;
const closeLine = (name) => `# <<< end of generated ${name}`;

// Every script carries its dialect's output kit: the protocol's shapes are the one thing no script may draw itself.
const REQUIRED = { sh: "kit.sh", ps1: "kit.ps1" };

const dialect = (file) => file.slice(file.lastIndexOf(".") + 1);

export const kitSources = () =>
    Object.fromEntries(
        readdirSync(join(root, KIT_DIR))
            .filter((name) => name.endsWith(".sh") || name.endsWith(".ps1"))
            .map((name) => [name, readFileSync(join(root, KIT_DIR, name), "utf8").replace(/\n*$/, "\n")]),
    );

export const scriptFiles = () =>
    readdirSync(join(root, SCRIPTS_DIR))
        .filter((name) => name.endsWith(".sh") || name.endsWith(".ps1"))
        .sort();

// The script as it should be: every region filled from its source. Problems are what --fix cannot mend.
export const render = (file, text, sources) => {
    const problems = [];
    const lines = text.split("\n");
    const out = [];
    const seen = new Set();
    for (let at = 0; at < lines.length; at++) {
        const line = lines[at];
        const opened = OPEN.exec(line);
        if (!opened) {
            out.push(line);
            continue;
        }
        const name = opened[1];
        const close = lines.indexOf(closeLine(name), at + 1);
        if (close === -1) {
            problems.push(`${file}:${at + 1} opens a generated ${name} region and never closes it (${closeLine(name)})`);
            out.push(...lines.slice(at));
            break;
        }
        if (sources[name] === undefined) {
            problems.push(`${file}:${at + 1} names ${KIT_DIR}/${name}, which does not exist`);
        } else if (dialect(name) !== dialect(file)) {
            problems.push(`${file}:${at + 1} pastes ${name} into a .${dialect(file)} script`);
        }
        seen.add(name);
        // An unknown source keeps the region as it stands, so the problem above is the only change.
        const body = sources[name] ?? `${lines.slice(at + 1, close).join("\n")}\n`;
        out.push(openLine(name), ...body.replace(/\n$/, "").split("\n"), closeLine(name));
        at = close;
    }
    const required = REQUIRED[dialect(file)];
    if (required && !seen.has(required)) {
        problems.push(`${file} carries no generated ${required} region; add the two marker lines (${openLine(required)} / ${closeLine(required)})`);
    }
    if (dialect(file) === "ps1") {
        for (const name of seen) {
            if (/[^\x00-\x7f]/.test(sources[name] ?? "")) {
                problems.push(`${KIT_DIR}/${name} holds a byte above 0x7F, and every .ps1 must be ASCII`);
            }
        }
    }
    return { text: out.join("\n"), problems };
};

// Every script, read and rendered: [{ file, stale, problems, text }].
export const readScripts = () => {
    const sources = kitSources();
    return scriptFiles().map((file) => {
        const path = join(root, SCRIPTS_DIR, file);
        const now = readFileSync(path, "utf8");
        const { text, problems } = render(file, now, sources);
        return { file, path, stale: text !== now, problems, text };
    });
};

export const writeScripts = () => {
    const written = [];
    for (const script of readScripts()) {
        if (script.stale && script.problems.length === 0) {
            writeFileSync(script.path, script.text);
            written.push(script.file);
        }
    }
    return written;
};

if (import.meta.url === `file://${process.argv[1]}`) {
    const written = writeScripts();
    console.log(written.length === 0 ? "scripts-kit: every generated region is current" : `scripts-kit: rewrote ${written.join(", ")}`);
}
