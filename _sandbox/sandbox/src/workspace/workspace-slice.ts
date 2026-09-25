import type { ResidentEngine } from "@intentic/iq-engine";
import type { DerivedSide, SidecarStatus, WorkspaceChildren, WorkspaceDerived, WorkspaceTree } from "@intentic/sandbox-contract";
import type { BlobSource, deriveBytes } from "../derived/derived-blob.js";
import type { workspaceArrivedEmpty } from "../scaffold/starter-site.js";
import type { version } from "../version.js";
import type { WorkspaceTrash } from "./files/trash/workspace-trash.js";
import type { OpenedWorkspaceFile, WorkspaceFileWindow } from "./files/workspace-files.js";
import type { WorkspacePaths } from "./workspace.js";

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
