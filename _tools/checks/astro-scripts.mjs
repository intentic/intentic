#!/usr/bin/env node
// No `<script` inside an .astro frontmatter. Vite's dependency scanner reads an .astro file as an HTML type and
// regex-lifts every `<script>…</script>` out of the raw bytes, frontmatter string literals included, then parses the
// text as TypeScript and resolves its imports as real ones. A code sample holding a script tag therefore kills
// `astro dev` at the scan — before Astro's parser runs — with a rolldown parse error pointing at a virtual module.
// Keep such samples in a .ts module and import them. Scripts in the template half, below the frontmatter, are real
// scripts and are what the scanner is for.
import { readFileSync } from "node:fs";
import { finish } from "./lib/report.mjs";
import { subjectFiles } from "./lib/repo.mjs";

const astroFiles = subjectFiles("*.astro");

const findings = [];
for (const path of astroFiles) {
    const lines = readFileSync(path, "utf8").split("\n");
    if (lines[0].trim() !== "---") {
        continue; // no frontmatter: every script in the file is a template script
    }
    for (let index = 1; index < lines.length; index++) {
        if (lines[index].trim() === "---") {
            break; // frontmatter closed
        }
        if (/<script[\s>]/i.test(lines[index])) {
            findings.push(
                `${path}:${index + 1}  move this sample to a .ts module and import it; vite's dep scan parses it as TypeScript where it sits`,
            );
        }
    }
}

finish([["Script tags inside .astro frontmatter", findings]], [`${astroFiles.length} .astro files, no script tag inside a frontmatter`]);
