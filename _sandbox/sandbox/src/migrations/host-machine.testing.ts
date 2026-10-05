import { unstubbed } from "@intentic/testing";
import { z } from "zod";
import type { HostHub } from "../hosts/host-peer.js";

// A connected device for the suites that read one (host-scan, provider-keys): it answers the two tools a direct read
// needs, list_dir and read_file, over a pretend home directory, and every other member of the hub names itself if
// reached. Not part of the build.

// A pretend home directory, keyed by absolute path the way the machine's own tools are addressed: text is a file, null a
// folder, and a path that is not there is neither.
export type MachineTree = Readonly<Record<string, string | null>>;

// The one call shape the direct read makes: an MCP `tools/call` naming a path.
const ToolCallSchema = z.object({ params: z.object({ name: z.string(), arguments: z.object({ path: z.string().default("") }) }) });

const answer = (text: string, isError = false) => ({ result: { content: [{ type: "text", text }], isError } });

// What sits directly inside `path`, each as list_dir reports it.
const children = (tree: MachineTree, path: string, separator: string) => {
    const prefix = `${path}${separator}`;
    const names = new Set(
        Object.keys(tree)
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length).split(separator)[0] ?? "")
            .filter((name) => name !== ""),
    );
    return [...names].map((name) => {
        const child = tree[`${prefix}${name}`];
        return child === null ? { name, kind: "directory" } : { name, kind: "file", size: Buffer.byteLength(child ?? "", "utf8") };
    });
};

export const machine = (tree: MachineTree, separator = "/") => {
    const calls: string[] = [];
    const hub = unstubbed<HostHub>("hostHub", {
        mcp: async (_id, payload) => {
            const { params } = ToolCallSchema.parse(payload);
            const path = params.arguments.path;
            calls.push(`${params.name} ${path}`);
            if (params.name === "list_dir") {
                return tree[path] === null ? answer(JSON.stringify(children(tree, path, separator))) : answer(`"${path}" is not a directory`, true);
            }
            const body = tree[path];
            return body === undefined || body === null ? answer("no such file", true) : answer(body);
        },
    });
    return { hub, calls };
};
