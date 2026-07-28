import { oc } from "@orpc/contract";
import { MemoryFileQuerySchema, MemoryFileSchema, MemoryListSchema, MemoryWriteSchema, OkSchema } from "../schemas.js";

// The agent's persistent memory notes (.intentic/claude/projects/<project>/memory) — the one browser surface
// for that control-plane subtree (see schemas.ts). Read for the memory panel; write/delete so the owner can
// curate what the agent remembers (fix a stale fact, drop a wrong one). oRPC's OpenAPI codec reads non-GET
// input from the JSON body, so write and delete send {project, name} in the body (same as /workspace/entry).
export const memoryContract = {
    list: oc.route({ method: "GET", path: "/memory" }).output(MemoryListSchema),
    read: oc.route({ method: "GET", path: "/memory/file" }).input(MemoryFileQuerySchema).output(MemoryFileSchema),
    write: oc.route({ method: "PUT", path: "/memory/file" }).input(MemoryWriteSchema).output(OkSchema),
    delete: oc.route({ method: "DELETE", path: "/memory/file" }).input(MemoryFileQuerySchema).output(OkSchema),
};
