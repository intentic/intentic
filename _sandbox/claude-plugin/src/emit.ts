import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fieldNotesSkill, fileqSkillText, outputStyle, portableIqNudge, statsSkill } from "./generated.js";
import { manifest } from "./manifest.js";

// The build's writer (build.mjs bundles this and runs it): generated/ from the texts other packages own, and the
// release version stamped into the committed manifest the way set-versions.sh stamps every package.json.

const write = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
};

// iq's teaching is the iq plugin's own files; resolved through the package so a move there fails the build here.
const iqFile = (specifier: string): string => readFileSync(createRequire(join(process.cwd(), "package.json")).resolve(specifier), "utf8");

export const emit = (root: string): void => {
    const generated = join(root, "generated");
    rmSync(generated, { recursive: true, force: true });
    write(join(generated, "skills", "fileq", "SKILL.md"), fileqSkillText());
    write(join(generated, "skills", "iq", "SKILL.md"), iqFile("@intentic/iq/skill"));
    write(join(generated, "skills", "field-notes", "SKILL.md"), fieldNotesSkill());
    write(join(generated, "skills", "stats", "SKILL.md"), statsSkill());
    write(join(generated, "output-styles", "intentic.md"), outputStyle());
    write(join(generated, "iq-nudge.txt"), portableIqNudge(iqFile("@intentic/iq/nudge")));
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    write(join(root, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest(version), undefined, 4)}\n`);
};

if (process.argv[1]?.endsWith("emit.mjs")) {
    emit(process.argv[2] ?? process.cwd());
}
