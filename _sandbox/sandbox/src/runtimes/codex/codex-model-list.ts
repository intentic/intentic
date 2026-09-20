import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Model } from "@intentic/sandbox-contract";
import { codexBinary } from "./codex-path.js";

// The Codex runtime's own catalog, read from the CLI that will run the turn (app-server `model/list`): display names,
// descriptions and the reasoning rungs each model accepts. Nothing here is curated — a rung Codex publishes is a rung
// the picker offers, including the ones only the newest models carry (max, ultra).
// /v1/models answers ids alone, so this is the only source that knows a model's scale; it is metadata, not
// availability, and never decides on its own which models an account may drive.

// A model row as app-server publishes it; fields Intentic doesn't render are left unread.
interface PublishedModel {
    readonly id: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly hidden?: boolean;
    readonly isDefault?: boolean;
    readonly supportedReasoningEfforts?: readonly { readonly reasoningEffort?: string }[];
}

// Spawn-to-answer budget for one `model/list`. The CLI answers in ~100ms from its own cache; past this the catalog
// falls to the id-only sources rather than holding a picker open.
const LIST_TIMEOUT_MS = 5_000;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

// Rungs as Codex spells them, weakest first, in the order it published them; unnamed entries drop out rather than
// reaching the picker as blanks.
const effortsOf = (row: PublishedModel): string[] =>
    (row.supportedReasoningEfforts ?? []).map((entry) => entry.reasoningEffort).filter((effort): effort is string => typeof effort === "string");

// One published row as a catalog Model. Label falls back to the id: a row with no display name still has to be
// pickable.
const toModel = (row: PublishedModel): Model => {
    const efforts = effortsOf(row);
    return {
        id: row.id,
        label: row.displayName ?? row.id,
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(row.description !== undefined ? { description: row.description } : {}),
    };
};

const publishedModels = (result: unknown): PublishedModel[] => {
    const data = asRecord(result)?.["data"];
    if (!Array.isArray(data)) {
        return [];
    }
    return data
        .map(asRecord)
        .filter((row): row is Record<string, unknown> => row !== undefined && typeof row["id"] === "string" && row["hidden"] !== true)
        .map((row) => row as unknown as PublishedModel);
};

// Codex's own answer first: the model it starts on leads the list, the rest keep the order it published them in.
const defaultFirst = (rows: readonly PublishedModel[]): PublishedModel[] => [
    ...rows.filter((row) => row.isDefault === true),
    ...rows.filter((row) => row.isDefault !== true),
];

export type CodexModelListReader = () => Promise<readonly Model[]>;

// One app-server, one request, then gone: this runs on a catalog refresh, not inside a turn, so it owns no thread and
// holds no process between reads.
const requestModelList = async (binary: string, env: Record<string, string>): Promise<unknown> => {
    // stderr is discarded rather than piped: nothing here reads it, and a full pipe would wedge the process this is
    // waiting on.
    const child = spawn(binary, ["app-server", "--stdio"], { env, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    try {
        return await new Promise<unknown>((resolve, reject) => {
            const done = (finish: () => void): void => {
                clearTimeout(timer);
                finish();
            };
            const timer = setTimeout(() => done(() => reject(new Error("Codex app-server did not answer model/list"))), LIST_TIMEOUT_MS);
            child.once("error", (error) => done(() => reject(error)));
            child.once("exit", () => done(() => reject(new Error("Codex app-server exited before answering model/list"))));
            lines.on("line", (line) => {
                if (line.trim() === "") {
                    return;
                }
                const message = asRecord(JSON.parse(line) as unknown);
                if (message?.["id"] === 2) {
                    done(() =>
                        message["error"] === undefined ? resolve(message["result"]) : reject(new Error("Codex app-server refused model/list")),
                    );
                }
            });
            // model/list needs no thread and no cwd, so all three messages go out together: app-server answers them in
            // order.
            const write = (message: unknown): void => {
                child.stdin.write(`${JSON.stringify(message)}\n`);
            };
            write({ method: "initialize", id: 1, params: { clientInfo: { name: "intentic", title: "Intentic", version: "1" }, capabilities: {} } });
            write({ method: "initialized", params: {} });
            write({ method: "model/list", id: 2, params: {} });
        });
    } finally {
        lines.close();
        child.kill();
    }
};

// CODEX_HOME pinned to the workspace auth store so the catalog is the signed-in account's, and CODEX_API_KEY dropped
// for the same reason the turn path drops it: a daemon-side bearer must not decide a native account's catalog.
const listEnv = (codexHome: string): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== "CODEX_API_KEY") {
            env[key] = value;
        }
    }
    return { ...env, CODEX_HOME: codexHome };
};

// Empty for every failure (no CLI in the image, an app-server that won't start, a malformed answer): this source
// enriches the catalog, so losing it costs metadata, never the models themselves.
export const codexModelList =
    (codexHome: string, binaryPath: () => Promise<string | undefined> = codexBinary): CodexModelListReader =>
    async () => {
        const binary = await binaryPath();
        if (binary === undefined) {
            return [];
        }
        return requestModelList(binary, listEnv(codexHome))
            .then((result) => defaultFirst(publishedModels(result)).map(toModel))
            .catch(() => []);
    };
