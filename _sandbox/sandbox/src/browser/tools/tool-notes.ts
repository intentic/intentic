import { z } from "zod";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import type { McpToolSchema } from "./browser-router.js";

// What the sandbox's browsers are, said in the tool descriptions a model reads before it calls them, where upstream's
// own words describe a browser on a developer's desk. Each note answers a mistake agents kept making (2026-11-03 audit
// of one game-building sandbox): reading SwiftShader frame times as the owner's GPU, writing Node into
// browser_run_code_unsafe, and opening a build over file://.

// Every browser here renders in software (software-rendering.ts), so a frame rate is the container's CPU, not a GPU.
const SOFTWARE_NOTE =
    "This sandbox browser renders in software (SwiftShader: WebGL through ANGLE, and on the `web` browser WebGPU as a " +
    "SwiftShader fallback adapter; the signed-in browsers have no WebGPU). There is no GPU: frame rates, frame times, " +
    "GPU names and auto-detected quality levels measured here are the container's CPU, never the owner's hardware, and " +
    "a heavy frame can take seconds.";

const RUN_CODE_NOTE =
    "`code` is an `async (page) => { ... }` function run in Playwright's process against its Page object, inside a VM " +
    "context: there is no require, import, process, fs or Buffer. For code inside the page use browser_evaluate; for " +
    "Node, use the shell.";

const NAVIGATE_NOTE =
    "file:// URLs are refused. Serve the directory over http instead (for example `python3 -m http.server 8000 --bind " +
    "127.0.0.1` run in it) and open http://localhost:8000/: WASM, module scripts and WebGPU need an http origin anyway.";

const NOTES = new Map<string, string>([
    ["browser_navigate", `${NAVIGATE_NOTE} ${SOFTWARE_NOTE}`],
    ["browser_take_screenshot", SOFTWARE_NOTE],
    ["browser_evaluate", SOFTWARE_NOTE],
    ["browser_run_code_unsafe", RUN_CODE_NOTE],
]);

const DescribedSchema = z.looseObject({ description: z.string().min(1) });

/** The listed tools, each one a note answers with that note after upstream's description. */
export const withSandboxNotes = (tools: readonly McpToolSchema[]): McpToolSchema[] =>
    tools.map((tool) => {
        const note = NOTES.get(tool.name);
        if (note === undefined) {
            return tool;
        }
        const upstream = DescribedSchema.safeParse(tool);
        return { ...tool, description: upstream.success ? `${upstream.data.description}\n\n${note}` : note };
    });

const FileNavigationSchema = z.looseObject({
    name: z.literal("browser_navigate"),
    arguments: z.looseObject({ url: z.string().regex(/^\s*file:/i) }),
});

/** Why a navigation to a file:// URL goes nowhere, said before any browser is started for it; undefined for any other call. */
export const fileUrlRefusal = (params: RpcMessage["params"]): string | undefined => {
    const parsed = FileNavigationSchema.safeParse(params);
    return parsed.success ? `${parsed.data.arguments.url}: ${NAVIGATE_NOTE}` : undefined;
};
