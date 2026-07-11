import { open } from "node:fs/promises";
import { extname, join } from "node:path";
import type { WorkspaceBucket, WorkspaceClassification, WorkspaceTree } from "@intentic/sandbox-contract";
import { fileTypeFromFile } from "file-type";

// Precise local mirror of a walked tree node. zod's recursive `get children()` degrades to Record<string,unknown>[]
// when WorkspaceTreeEntry is emitted to a cross-package .d.ts, so the contract type is opaque to consumers — we
// traverse against this instead and cast once at the entry point (walkWorkspaceTree is the source of this shape).
type TreeNode = { name: string; path: string; type: "file" | "dir"; size?: number; ignored?: boolean; children?: TreeNode[] };

// Deterministic, no-LLM workspace classifier — a 3-stage cascade (repo markers → magic bytes → extension/text
// fallback) that sorts what the user dropped into /work into coarse buckets. It runs over the already-walked
// WorkspaceTree (walkWorkspaceTree) and skips its `ignored` entries (node_modules, .git, .gitignore'd), so it only
// ever classifies the tracked workspace and never traverses the disk a second time. Read-only: it proposes, it
// never moves.

type Item = WorkspaceClassification["classifications"][number];

// Stage 1 — a directory holding any of these at its root is one repository unit; classify it and stop descending
// (its contents belong to the repo, not the workspace). `.git` is a grayed `ignored` entry we skip, so detection
// rides on the project manifests, which is the reliable signal anyway.
const REPO_MARKERS = new Set([
    "package.json",
    "go.mod",
    "Cargo.toml",
    "pyproject.toml",
    "setup.py",
    "pom.xml",
    "build.gradle",
    "composer.json",
    "Gemfile",
]);
const REPO_MARKER_SUFFIXES = [".sln", ".csproj"];

const repoMarker = (children: readonly TreeNode[]): string | undefined => {
    for (const child of children) {
        if (child.type !== "file") continue;
        if (REPO_MARKERS.has(child.name) || REPO_MARKER_SUFFIXES.some((s) => child.name.endsWith(s))) return child.name;
    }
    return undefined;
};

// Stage 2 — magic-byte MIME → bucket. Prefix classes cover the media families; the exact sets pin document and
// archive containers (docx/xlsx/pptx resolve to their own OOXML mimes via file-type, not "application/zip").
const DOC_MIMES = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/epub+zip",
]);
const ARCHIVE_MIMES = new Set([
    "application/zip",
    "application/x-tar",
    "application/gzip",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "application/x-bzip2",
]);

const mimeBucket = (mime: string): WorkspaceBucket | undefined => {
    if (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")) return "media";
    if (DOC_MIMES.has(mime)) return "documents";
    if (ARCHIVE_MIMES.has(mime)) return "archives";
    return undefined;
};

// Stage 3 — extension → bucket, for the many text-based formats magic bytes are blind to (.md, .csv, .svg have
// no signature) and formats file-type doesn't sniff.
const EXT_BUCKET: Record<string, WorkspaceBucket> = {
    ".pdf": "documents",
    ".doc": "documents",
    ".docx": "documents",
    ".odt": "documents",
    ".rtf": "documents",
    ".txt": "documents",
    ".md": "documents",
    ".csv": "documents",
    ".xls": "documents",
    ".xlsx": "documents",
    ".ods": "documents",
    ".ppt": "documents",
    ".pptx": "documents",
    ".odp": "documents",
    ".epub": "documents",
    ".png": "media",
    ".jpg": "media",
    ".jpeg": "media",
    ".gif": "media",
    ".webp": "media",
    ".svg": "media",
    ".mp3": "media",
    ".wav": "media",
    ".flac": "media",
    ".mp4": "media",
    ".mov": "media",
    ".mkv": "media",
    ".zip": "archives",
    ".tar": "archives",
    ".gz": "archives",
    ".tgz": "archives",
    ".7z": "archives",
    ".rar": "archives",
    ".bz2": "archives",
};

// Last-resort text sniff for extension-less, magic-less files (READMEs, notes): UTF-8-ish with no NUL and no
// stray control bytes reads as a document; anything else is opaque binary → other.
const isProbablyText = async (abs: string): Promise<boolean> => {
    const fd = await open(abs, "r");
    try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fd.read(buf, 0, 4096, 0);
        for (const b of buf.subarray(0, bytesRead)) {
            if (b === 9 || b === 10 || b === 13) continue; // tab, LF, CR
            if (b < 32) return false; // NUL / other C0 control byte ⇒ binary
        }
        return true;
    } finally {
        await fd.close();
    }
};

const classifyFile = async (abs: string, path: string): Promise<Item> => {
    const magic = await fileTypeFromFile(abs);
    if (magic) {
        // A recognized binary we don't bucket (e.g. application/wasm) is still "other", but keep the mime as the
        // explainable reason.
        return { path, bucket: mimeBucket(magic.mime) ?? "other", reason: `magic:${magic.mime}` };
    }
    const ext = extname(path).toLowerCase();
    const byExt = EXT_BUCKET[ext];
    if (byExt) return { path, bucket: byExt, reason: `ext:${ext}` };
    if (await isProbablyText(abs)) return { path, bucket: "documents", reason: "text-content" };
    return { path, bucket: "other", reason: "unknown" };
};

// Classify a walked workspace tree. Repo dirs collapse to one entry (not descended); every other loose file gets
// a bucket. `root` resolves the tree's root-relative paths back to absolute for the magic/text reads.
export const classifyWorkspace = async (root: string, tree: WorkspaceTree): Promise<WorkspaceClassification> => {
    const classifications: Item[] = [];
    const visit = async (entries: readonly TreeNode[]): Promise<void> => {
        for (const entry of entries) {
            if (entry.ignored) {
                continue; // grayed (node_modules, .git, .gitignore'd) — not part of the dropped workspace
            }
            if (entry.type === "dir") {
                const children = entry.children ?? [];
                const marker = repoMarker(children);
                if (marker) {
                    classifications.push({ path: entry.path, bucket: "repositories", reason: `repository:${marker}` });
                    continue; // one repo unit — do not descend
                }
                // oxlint-disable-next-line eslint/no-await-in-loop -- sequential I/O over an in-memory tree; parallelizing a drop buys nothing and risks fd exhaustion
                await visit(children);
            } else {
                // oxlint-disable-next-line eslint/no-await-in-loop -- see above
                classifications.push(await classifyFile(join(root, entry.path), entry.path));
            }
        }
    };
    await visit(tree.tree as unknown as readonly TreeNode[]);
    return { classifications };
};
