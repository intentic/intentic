import type { GitChange } from "@intentic/sandbox-contract";

// Turns a commit's flat changed-file list into a collapsible directory tree with VSCode-style compact folders: a
// directory holding only one subdirectory merges into one row ("sandbox / src"). Pure and unit-tested; the caller owns
// only collapse state and rendering.

interface FileNode {
    readonly type: "file";
    readonly name: string;
    readonly file: GitChange;
}
interface DirNode {
    readonly type: "dir";
    // Display name, a joined chain ("sandbox / src") when folders were compacted.
    readonly name: string;
    // Full root-relative dir path, the stable key for collapse state.
    readonly path: string;
    readonly children: readonly TreeNode[];
}
export type TreeNode = FileNode | DirNode;

// Flattened render row, dirs then files, alphabetical, with nesting depth; a discriminated union narrowed by `kind`.
// `path` is the collapse key for a dir, the diff target for a file.
export type FileTreeRow =
    | { readonly kind: "dir"; readonly depth: number; readonly name: string; readonly path: string; readonly expanded: boolean }
    | { readonly kind: "file"; readonly depth: number; readonly name: string; readonly path: string; readonly file: GitChange };

interface Raw {
    readonly dirs: Map<string, Raw>;
    readonly files: FileNode[];
}

export const buildFileTree = (files: readonly GitChange[]): TreeNode[] => {
    const root: Raw = { dirs: new Map(), files: [] };
    for (const file of files) {
        const segments = file.path.split("/");
        const name = segments.pop() ?? file.path;
        let node = root;
        for (const segment of segments) {
            let child = node.dirs.get(segment);
            if (child === undefined) {
                child = { dirs: new Map(), files: [] };
                node.dirs.set(segment, child);
            }
            node = child;
        }
        node.files.push({ type: "file", name, file });
    }

    const convert = (raw: Raw, prefix: string): TreeNode[] => {
        const dirs: DirNode[] = [];
        for (const [name, child] of raw.dirs) {
            let dirName = name;
            let dirPath = prefix === "" ? name : `${prefix}/${name}`;
            let current = child;
            // Compact single-child chains: a dir with no files and exactly one subdir merges names with it.
            while (current.files.length === 0 && current.dirs.size === 1) {
                const [childName, grandchild] = [...current.dirs.entries()][0]!;
                dirName = `${dirName} / ${childName}`;
                dirPath = `${dirPath}/${childName}`;
                current = grandchild;
            }
            dirs.push({ type: "dir", name: dirName, path: dirPath, children: convert(current, dirPath) });
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        const fileNodes = raw.files.toSorted((a, b) => a.name.localeCompare(b.name));
        return [...dirs, ...fileNodes];
    };
    return convert(root, "");
};

// Walk the tree into render rows, skipping the subtree of any collapsed directory (keyed by its path).
export const flattenFileTree = (nodes: readonly TreeNode[], collapsed: ReadonlySet<string>, depth = 0): FileTreeRow[] => {
    const rows: FileTreeRow[] = [];
    for (const node of nodes) {
        if (node.type === "dir") {
            const expanded = !collapsed.has(node.path);
            rows.push({ kind: "dir", depth, name: node.name, path: node.path, expanded });
            if (expanded) {
                rows.push(...flattenFileTree(node.children, collapsed, depth + 1));
            }
        } else {
            rows.push({ kind: "file", depth, name: node.name, path: node.file.path, file: node.file });
        }
    }
    return rows;
};
