import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { z } from "zod";
import { parsedJsonLines } from "@intentic/base/json-lines";
import { cacheFile } from "../../store/open-document.js";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import type { McpToolSchema } from "./browser-router.js";

// What the browser router (browser-router.ts) shares with the probe that learns its tool list: the protocol it speaks
// to a backend, how it reads a backend's lines, and the tool list itself, probed once per @playwright/mcp version.

export const PROTOCOL_VERSION = "2025-06-18";
export const ROUTER_CLIENT = { name: "intentic-browser-router", version: "1.0.0" };

// The members of a JSON-RPC message the router routes on; `result` and `error` ride along as they came.
const RpcLineSchema = z.looseObject({
    jsonrpc: z.literal("2.0").exactOptional(),
    id: z.union([z.string(), z.number(), z.null()]).exactOptional(),
    method: z.string().exactOptional(),
    params: z.record(z.string(), z.unknown()).exactOptional(),
});

// Hands each JSON-RPC object a backend prints to `onMessage`. A stray non-JSON line (a warning printed to stdout), or
// JSON that is not a message, carries nothing to route and is passed over.
export const onMessages = (stdout: Readable, onMessage: (message: RpcMessage) => void): void => {
    void (async () => {
        for await (const value of parsedJsonLines(stdout)) {
            const message = RpcLineSchema.safeParse(value);
            if (message.success) {
                onMessage(message.data);
            }
        }
        // allow(silent-catch): a stdout torn down with its process ends the reading; the exit handlers settle what was pending.
    })().catch(() => undefined);
};

// ---- the tool schemas, probed once per @playwright/mcp version and cached on disk for every later daemon ----------

// What the cache must hold to be served: a list of named tools whose input schema, when present, has the shape the
// router extends with `account`. Anything else is probed again and written over.
const cachedToolList = z.array(
    z.looseObject({
        name: z.string(),
        inputSchema: z
            .looseObject({
                type: z.string().exactOptional(),
                properties: z.record(z.string(), z.unknown()).exactOptional(),
                required: z.array(z.string()).exactOptional(),
            })
            .exactOptional(),
    }),
);

// A tools/list answer: its tools, read as the cache reads them.
const ProbedToolsSchema = z.looseObject({ tools: cachedToolList });

// Asks a throwaway headless server for its tool list: initialize, tools/list, done. It never opens a page, so it
// launches no Chromium.
const probeTools = (probe: { readonly command: string; readonly args: readonly string[] }, timeoutMs: number): Promise<McpToolSchema[]> =>
    new Promise((resolve, reject) => {
        const child = spawn(probe.command, [...probe.args], { stdio: ["pipe", "pipe", "ignore"] });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("schema probe timed out"));
        }, timeoutMs);
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        const send = (message: RpcMessage): void => {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        };
        onMessages(child.stdout, (message) => {
            if (message.id === "probe-init") {
                send({ jsonrpc: "2.0", method: "notifications/initialized" });
                send({ jsonrpc: "2.0", id: "probe-tools", method: "tools/list", params: {} });
            } else if (message.id === "probe-tools") {
                clearTimeout(timer);
                child.kill("SIGTERM");
                const probed = ProbedToolsSchema.safeParse(message.result);
                // A list the cache could not hold is not written: the next turn probes again.
                if (probed.success) {
                    resolve(probed.data.tools);
                } else {
                    reject(new Error("the schema probe answered no tool list"));
                }
            }
        });
        send({
            jsonrpc: "2.0",
            id: "probe-init",
            method: "initialize",
            params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: ROUTER_CLIENT },
        });
    });

// Memoized per cache path: every router in this daemon shares one read, or one probe on a version's first use. A
// failed probe is forgotten so the next turn tries again rather than inheriting "no browser tools" for the boot.
export const createSchemaCache = (timeoutMs = 30_000) => {
    const loaded = new Map<string, Promise<McpToolSchema[]>>();
    return (cachePath: string, probe: { readonly command: string; readonly args: readonly string[] }): Promise<McpToolSchema[]> => {
        const known = loaded.get(cachePath);
        if (known !== undefined) {
            return known;
        }
        // Written atomically, so two daemons probing at once cannot interleave one file.
        const file = cacheFile<McpToolSchema[] | undefined>(cachePath, {
            parse: (raw) => cachedToolList.safeParse(raw).data,
            fallback: () => undefined,
        });
        const reading = (async () => {
            const cached = await file.read();
            if (cached !== undefined) {
                return cached;
            }
            const tools = await probeTools(probe, timeoutMs);
            // allow(silent-catch): a cache that could not be written costs the next boot one more probe; this answer is in hand.
            await file.update(() => tools).catch(() => undefined);
            return tools;
        })();
        loaded.set(cachePath, reading);
        reading.catch(() => loaded.delete(cachePath));
        return reading;
    };
};
