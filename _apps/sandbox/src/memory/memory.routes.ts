import { memoryContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { deleteMemoryFile, listMemoryFiles, memoryRoot, readMemoryFile, writeMemoryFile } from "./memory-files.js";

export type MemoryRoutesDeps = Pick<Services, "workspace">;

// The agent's persistent memory notes (.intentic/claude/projects/<project>/memory) — list/read for the memory
// panel, write/delete so the owner can curate what the agent remembers. The fs layer scopes every path to the
// memory dirs; nothing else in the control-plane tree is reachable through here.
export const createMemoryRoutes = (services: MemoryRoutesDeps) => {
    const i = implement(memoryContract).$context<OrpcContext>();
    const root = memoryRoot(services.workspace.root);
    return {
        list: i.list.handler(async () => ({ files: await listMemoryFiles(root) })),
        read: i.read.handler(async ({ input }) => {
            const file = await readMemoryFile(root, input.project, input.name);
            if (file === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no such memory" });
            }
            return { project: input.project, name: input.name, ...file };
        }),
        write: i.write.handler(async ({ input }) => {
            if (!(await writeMemoryFile(root, input.project, input.name, input.content))) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid memory path (must be a .md file inside a project's memory dir)" });
            }
            return { ok: true } as const;
        }),
        delete: i.delete.handler(async ({ input }) => {
            if (!(await deleteMemoryFile(root, input.project, input.name))) {
                throw new ORPCError("NOT_FOUND", { message: "no such memory" });
            }
            return { ok: true } as const;
        }),
    };
};
