import type { ExtensionServerApi, ExtensionServerContext } from "@intentic/extension-api";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import { memoryContract } from "./contract.js";
import { deleteMemoryFile, listMemoryFiles, memoryRoot, readMemoryFile, writeMemoryFile } from "./memory-files.js";

/* ext-memory's backend half — the /memory routes that used to be daemon core, now served from the extension's
 * own namespace (/x/intentic.memory, prefix already stripped by the backend host). The extension builds its
 * router from its OWN contract (contract.ts) — the host only ever sees a fetch handler, so what speaks oRPC
 * here is this extension's choice, not the platform's. */

export const activateServer = (api: ExtensionServerApi, _context: ExtensionServerContext): void => {
    const i = implement(memoryContract);
    const root = memoryRoot(api.workspaceRoot);
    const router = i.router({
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
    });
    const handler = new OpenAPIHandler(router);
    api.routes.mount(async (request) => {
        const { matched, response } = await handler.handle(request, { prefix: "/" });
        return matched ? response : undefined;
    });
};
