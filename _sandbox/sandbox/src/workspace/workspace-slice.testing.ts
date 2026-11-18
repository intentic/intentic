import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { createTextSearch } from "./text-search.js";
import { workspacePaths } from "./workspace.js";
import type { WorkspaceSlice } from "./workspace-slice.js";

// The workspace slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// The files seam with every method a no-op by default; a test overrides just the ones it asserts on.
export const fakeFiles = (overrides: Partial<WorkspaceSlice["files"]> = {}): WorkspaceSlice["files"] =>
    unstubbed("files", {
        read: async () => undefined,
        readWindow: async () => undefined,
        write: async () => {},
        writeStream: async () => {},
        open: async () => undefined,
        size: async () => undefined,
        mkdir: async () => {},
        remove: async () => {},
        trash: {
            put: async () => undefined,
            restore: async () => {
                throw new Error("fakeFiles: nothing in the trash");
            },
            sweep: async () => {},
        },
        move: async () => {},
        copy: async () => {},
        ...overrides,
    });

export const workspaceSliceFake = () =>
    ({
        workspace: workspacePaths(WORKSPACE_ROOT),
        // `derived` is composed by the harness, since derived already reaches this subsystem.
        files: fakeFiles(),
        workspaceTree: async () => ({ root: WORKSPACE_ROOT, tree: [], hidden: 0, barren: [] }),
        workspaceTreeChanged: () => undefined,
        workspaceWritten: () => undefined,
        // The real one: it reads only the root a search names, which a route test sets to its own temp workspace.
        textSearch: createTextSearch({ rgPath: undefined }),
    }) satisfies Partial<WorkspaceSlice>;
