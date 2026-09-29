import { DERIVED_DIR } from "./lib/sidecar.js";

// fileq's own teaching: the SKILL.md every agent that has fileq on its PATH is given. It lives with the CLI it describes
// so a new flag and its sentence land together, and so the two hosts that ship it cannot drift: the sandbox writes it
// into the workspace's skills (the daemon's settings/skills.ts), the Claude Code plugin ships it as its fileq skill.
// Only what the host itself provides differs: the sandbox image carries tesseract through an extension and wires fileq
// as git's textconv; a standalone install has neither until its owner adds them.

export interface FileqSkillHost {
    // "sandbox": the Intentic sandbox image. "standalone": fileq on anyone's machine (the Claude Code plugin, npm).
    readonly host: "sandbox" | "standalone";
}

const OCR_FORMAT: Record<FileqSkillHost["host"], string> = {
    sandbox: "a scan is OCR'd when the image carries tesseract",
    standalone: "a scan is OCR'd when `tesseract` is on PATH",
};

const OCR_REFUSAL: Record<FileqSkillHost["host"], string> = {
    sandbox: `- A scanned PDF on an image without tesseract answers "no usable text layer … OCR is not part of this tier"
  rather than an empty page; images say "no visual description". Treat those notes as "not generated",
  never as "nothing there". An extension that ships tesseract (office) turns the first into OCR.`,
    standalone: `- A scanned PDF with no \`tesseract\` on PATH answers "no usable text layer … OCR is not part of this tier"
  rather than an empty page; images say "no visual description". Treat those notes as "not generated",
  never as "nothing there". Installing tesseract turns the first into OCR.`,
};

// Only where `fileq git-attributes` has wired it, which the sandbox image does and a plain install does not.
const TEXTCONV = `## What changed in a document
\`git diff\`, \`git show\` and \`git log -p\` on a .docx, .xlsx, .pptx, .pdf or .ipynb print the change to its
text, not "Binary files differ": every derivable extension is routed through fileq as git's textconv. Read the
diff; do not convert both versions by hand.

`;

export const fileqSkill = ({ host }: FileqSkillHost): string => `---
name: fileq
description: Read binary workspace files (docx, odt, xlsx, pptx, pdf, epub, ipynb, images, audio, zip and tar archives, V8 CPU and heap profiles) as clean budgeted markdown with the \`fileq\` CLI, and read big text-shaped files (csv, json, logs) without flooding your context. Use whenever a task needs the contents of a document, the text layer of a PDF, the metadata of an image or recording, what is inside an archive, or a look inside a file too large to cat — instead of guessing from the filename or shelling out to ad-hoc converters.
---

# fileq: binary files as markdown

The \`fileq\` CLI (on PATH) turns the workspace files you cannot open as text into markdown, and keeps a
sidecar copy fresh so reading twice derives once.

## Read a file
\`fileq <file>\` (or \`fileq read <file> --budget 8000\`)
- Prints a capsule (format, token cost), the content up to the budget, and \`saved:\` — the sidecar path
  carrying the whole thing. Over budget, the cut is announced with that exact path to Read.
- Formats: docx and odt (headings, lists, tables), xlsx (capped tables), pptx (slides + speaker notes),
  pdf (text layer; ${OCR_FORMAT[host]}, and the note says the words are
  recognised, not exact), epub (chapters in reading order), ipynb (cells, fenced code, capped outputs),
  png/jpg/gif/webp (dimensions + EXIF), mp3/wav/flac/mp4/… (duration + tags), html, and V8 profiles
  (\`.cpuprofile\` from \`node --cpu-prof\`, \`.heapprofile\` from \`--heap-prof\`) as functions ranked by self and total cost.
- Archives (zip, jar, whl, tar, tgz, and what tar can open: xz, bzip2, zstd) derive to a MEMBER LISTING —
  paths and sizes, capped — never their contents: unpack one if you need what is inside. A single
  compressed file (\`server.log.gz\`) is the exception and derives to its text, since there the archive is
  the document. 7z and rar answer that nothing here opens them.

## Check the sidecar first
A file may already have a shadow at \`${DERIVED_DIR}/<path>.md\` — front matter says which
source hash it was derived from. \`fileq read\` checks freshness for you, so prefer it over trusting a
shadow's age by eye.

## What it refuses, and why
${OCR_REFUSAL[host]}
- Plain text (md, csv, txt, code) is not fileq's business: Read it directly — but see below for the big ones.
- Web pages belong to \`webq\`; images for a vision model belong to the Read tool, which shows the pixels.

${host === "sandbox" ? TEXTCONV : ""}Exit codes: 0 content, 1 nothing derivable, 2 broken invocation or install.

## Text-shaped files that are too big to cat
The commonest way to lose a context window is \`cat\` on a file you have not sized. Stat first, then read
the shape, then only what the question needs:
- **Size first**: \`wc -c <file>\`. Under ~20 KB, Read it whole. Over, \`head -100\` and \`tail -100\` to
  orient, \`rg\` for what the task actually asks about, the whole file only if you genuinely need all of it.
- **CSV / TSV**: never \`head -n 5\` blindly — a 50 KB quoted cell in row 1 wrecks it. \`head -c 4000\` for
  a glance; for the shape, python with \`csv\` and a row cap, or \`fileq\` after converting to xlsx is
  overkill: \`python3 -c 'import csv,sys; r=csv.reader(open(sys.argv[1])); print(next(r)); print(sum(1 for _ in r))' <file>\`
  gives header and row count without loading it all.
- **JSON**: structure before content — \`jq 'type' <file>\`, then \`jq 'if type=="array" then length elif type=="object" then keys else . end'\`
  (guarded: \`keys\` errors on a scalar root). Drill only into what was asked. **JSONL**: never \`jq\` the
  whole file; \`head -3 <file> | jq .\` and \`wc -l\`.
- **Logs**: the end is what matters — \`tail -200\`, then \`rg\` for the error text.
- **Archives (zip, tar.*)**: list, never auto-extract — \`unzip -l\`, \`tar -tf\` (auto-detects compression).
  Extract one member with \`unzip -p <zip> <path>\` or \`tar -xOf <tar> <path>\`. A single \`.gz\` has no
  listing: \`zcat <file> | head -50\`.
- **Unknown extension**: \`file <path>\` then \`xxd <path> | head -5\`; if the bytes mean nothing to you,
  ask rather than guess.
`;
