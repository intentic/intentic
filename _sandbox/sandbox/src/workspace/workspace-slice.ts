import { resolve } from "node:path";
import type { ResidentEngine } from "@intentic/iq-engine";
import type { DerivedSide, SidecarStatus, WorkspaceChildren, WorkspaceDerived, WorkspaceTree } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { BlobSource } from "../derived/derived-blob.js";
import type { Config } from "../env.config.js";
import { statePath } from "../state-paths.js";
import { createCodeSearchEngine } from "./code-search.js";
import { heldDirReads } from "./files/dir-reads.js";
import { createWorkspaceTrash, type WorkspaceTrash } from "./files/trash/workspace-trash.js";
import { extractArchive } from "./files/workspace-extract.js";
import {
    copyWorkspacePath,
    makeWorkspaceDir,
    moveWorkspacePath,
    openWorkspaceFile,
    type OpenedWorkspaceFile,
    readWorkspaceFile,
    readWorkspaceFileWindow,
    removeWorkspacePath,
    setWorkspaceMtime,
    statWorkspaceFileSize,
    type WorkspaceFileWindow,
    writeWorkspaceFile,
} from "./files/workspace-files.js";
import { writeWorkspaceFileStream } from "./files/workspace-files-upload.js";
import { coalescingWorkspaceTree } from "./files/workspace-tree-coalesce.js";
import { listWorkspaceChildren, walkWorkspaceTree } from "./files/workspace-tree.js";
import { residentWorkspaceTree } from "./watch/workspace-watch.js";
import { type WorkspacePaths, workspacePaths } from "./workspace.js";

// The workspace tree: its paths, files, derived sidecars, tree reads and the code-search engine.
export interface WorkspaceSlice {
    readonly workspace: WorkspacePaths;
    // Was /work empty at daemon start; must be asked before any boot step writes into the workspace, not later.
    readonly workspaceArrivedEmpty: boolean;
    readonly files: {
        readonly read: (absPath: string) => Promise<string | undefined>;
        // One bounded window of a file's text, for the browser's own route; `read` stays for already-bounded readers.
        readonly readWindow: (absPath: string, offset?: number, limit?: number) => Promise<WorkspaceFileWindow | undefined>;
        readonly write: (absPath: string, content: string | Uint8Array) => Promise<void>;
        readonly writeStream: (absPath: string, body: ReadableStream<Uint8Array>, limit: number, offset?: number) => Promise<void>;
        readonly setMtime: (absPath: string, mtimeMs: number) => Promise<void>;
        // A file to stream, with its size and validator; its bytes are opened only when asked for.
        readonly open: (absPath: string) => Promise<OpenedWorkspaceFile | undefined>;
        readonly size: (absPath: string) => Promise<number | undefined>;
        readonly mkdir: (absPath: string) => Promise<void>;
        readonly remove: (absPath: string) => Promise<void>;
        // Where the file view's deletes go, so Undo can bring them back.
        readonly trash: WorkspaceTrash;
        readonly move: (fromAbs: string, toAbs: string) => Promise<void>;
        readonly copy: (fromAbs: string, toAbs: string) => Promise<void>;
        // Unpacks an archive beside itself, answering with the absolute path of what landed.
        readonly extract: (absArchive: string) => Promise<string>;
    };
    // A binary file's markdown shadow, read and derived on demand; wired here so no route reaches into fileq's own
    // subsystem, which reads workspace files itself.
    readonly derived: {
        readonly read: (root: string, relPath: string) => Promise<WorkspaceDerived>;
        readonly derive: (root: string, relPath: string) => Promise<WorkspaceDerived>;
        // Bytes that are no workspace file (a past version at a rev-spec), rendered and kept by content hash.
        readonly deriveBytes: (root: string, bytes: Uint8Array, source: BlobSource) => Promise<DerivedSide>;
        // How the background pass is doing; the one derived answer no file on disk carries.
        readonly status: () => SidecarStatus;
    };
    readonly workspaceTree: (root: string) => Promise<WorkspaceTree>;
    // What the watcher saw change under the workspace root, root-relative; empty is an unnamed change. The tree walk holds
    // folder reads between refetches and drops exactly these.
    readonly workspaceTreeChanged: (relPaths: readonly string[]) => void;
    readonly workspaceChildren: (root: string, relPath: string, options?: { depth?: number }) => Promise<WorkspaceChildren>;
    // Resident workspace search: one iq engine, its sweep cached in memory; indexing runs on its own thread.
    readonly iq: ResidentEngine;
}

// The members derived/ and scaffold/ build, which composition.ts adds: both import workspace back, so building them
// here would close a cycle.
export type DerivedMembers = "derived" | "workspaceArrivedEmpty";

// Builds the workspace slice from config alone; everything else reads the workspace paths off it.
export const createWorkspaceSlice = ({ config, logger }: { readonly config: Config; readonly logger: Logger }): Omit<WorkspaceSlice, DerivedMembers> => {
    const workspace = workspacePaths(config.workspaceRoot);
    const treeReads = heldDirReads(workspace.root);
    // Shared by every caller that walks at once; one walk per checkout serves them all.
    const walkedWorkspaceTree = coalescingWorkspaceTree((root: string) =>
        walkWorkspaceTree(root, resolve(root) === resolve(workspace.root) ? { reads: treeReads } : {}),
    );
    return {
        workspace,
        files: {
            read: readWorkspaceFile,
            readWindow: readWorkspaceFileWindow,
            write: writeWorkspaceFile,
            writeStream: writeWorkspaceFileStream,
            setMtime: setWorkspaceMtime,
            open: openWorkspaceFile,
            size: statWorkspaceFileSize,
            mkdir: makeWorkspaceDir,
            remove: removeWorkspacePath,
            trash: createWorkspaceTrash(statePath(workspace.root, ".intentic/local/trash/")),
            move: moveWorkspacePath,
            copy: copyWorkspacePath,
            extract: extractArchive,
        },
        // The watched workspace answers from the tree its watcher holds; the walk behind it reads the workspace through
        // what that watcher keeps current, and a conversation's own checkout straight from disk.
        workspaceTree: (root: string) => residentWorkspaceTree(root) ?? walkedWorkspaceTree(root),
        workspaceTreeChanged: treeReads.changed,
        workspaceChildren: listWorkspaceChildren,
        iq: createCodeSearchEngine(config, workspace.root, logger),
    };
};
