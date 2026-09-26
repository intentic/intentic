import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
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

export interface WorkspaceFakeOverrides {
    readonly iq?: Partial<WorkspaceSlice["iq"]> | undefined;
}

export const workspaceSliceFake = ({ iq }: WorkspaceFakeOverrides) =>
    ({
        workspace: workspacePaths(WORKSPACE_ROOT),
        // `derived` is composed by the harness, since derived already reaches this subsystem.
        files: fakeFiles(),
        workspaceTree: async () => ({ root: WORKSPACE_ROOT, tree: [], hidden: 0, barren: [] }),
        workspaceTreeChanged: () => undefined,
        // Inert resident search, no index, no rg; the search route test overrides `run` with a canned outcome.
        iq: unstubbed<WorkspaceSlice["iq"]>("iq", {
            metrics: () => ({
                files: 0,
                generation: 0,
                dirtySequence: 0,
                appliedSequence: 0,
                revalidated: true,
                sweepAgeMs: 0,
                embedBacklog: 0,
                queryWorker: { live: false, pendingRequests: 0 },
            }),
            run: async () => ({
                result: { mode: "q", total: 0, files: 0, shown: 0, groups: [], freshness: { state: "fresh" as const }, truncated: false },
                text: "",
                exitCode: 1 as const,
            }),
            health: async () => ({
                totals: { files: 0, symbols: 0, complexity: 0, hotspots: 0 },
                hotspots: [],
                modules: [],
                freshness: { state: "fresh" as const },
            }),
            invalidateHealth: () => {},
            markDirty: () => {},
            warm: async () => ({ files: 0, symbols: 0, chunks: 0, embedded: 0, generation: 0, freshness: { state: "fresh" as const, ageMs: 0 } }),
            close: async () => {},
            ...iq,
        }),
    }) satisfies Partial<WorkspaceSlice>;
