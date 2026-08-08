import { oc } from "@orpc/contract";
import { MemoryFileQuerySchema, MemoryFileSchema, MemoryListSchema, MemoryWriteSchema, OkSchema } from "../contract.js";

// The agent's persistent memory notes (.intentic/claude/projects/<project>/memory) — read for the memory
// panel, write/delete so the owner can curate what the agent remembers. oRPC's OpenAPI codec reads non-GET
// input from the JSON body, so write and delete send {project, name} in the body.
export const memoryContract = {
    list: oc.route({ method: "GET", path: "/memory" }).output(MemoryListSchema),
    read: oc.route({ method: "GET", path: "/memory/file" }).input(MemoryFileQuerySchema).output(MemoryFileSchema),
    write: oc.route({ method: "PUT", path: "/memory/file" }).input(MemoryWriteSchema).output(OkSchema),
    delete: oc.route({ method: "DELETE", path: "/memory/file" }).input(MemoryFileQuerySchema).output(OkSchema),
};
