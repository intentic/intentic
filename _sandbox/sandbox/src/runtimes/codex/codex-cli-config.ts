import { namespaceTargetOf, nsenterArgv } from "../../workload/namespace-entry.js";
import type { CodexTurn, JsonValue } from "./codex-app-server.js";

const isConfigTable = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
    value !== null && typeof value === "object" && !Array.isArray(value);

// CLI overrides take TOML values, including inline tables for a provider's headers.
const configValueToml = (value: JsonValue): string => {
    if (value === null) {
        throw new Error("Codex startup config cannot contain null");
    }
    if (Array.isArray(value)) {
        return `[${value.map(configValueToml).join(", ")}]`;
    }
    if (isConfigTable(value)) {
        return `{ ${Object.entries(value)
            .map(([key, entry]) => `${JSON.stringify(key)} = ${configValueToml(entry)}`)
            .join(", ")} }`;
    }
    return JSON.stringify(value);
};

// Since 0.166, turn admission compares the thread's provider with app-server's startup config. Each process must
// select its turn's provider there too, without rewriting the CODEX_HOME shared by other turns.
const startupProviderArgs = (turn: CodexTurn): string[] => {
    if (turn.modelProvider === undefined) {
        return [];
    }
    const key = `model_providers.${turn.modelProvider}`;
    const provider = turn.config?.[key];
    return [
        "-c",
        `model_provider=${configValueToml(turn.modelProvider)}`,
        ...(provider === undefined ? [] : ["-c", `${key}=${configValueToml(provider)}`]),
    ];
};

export const codexAppServerArgv = (binary: string, turn: CodexTurn): { command: string; args: readonly string[] } => {
    const args = ["app-server", "--stdio", ...startupProviderArgs(turn)];
    // nsenter execs app-server into the turn's anchor, staying a direct child; its cwd wins over workingDirectory.
    return turn.namespace === undefined
        ? { command: binary, args }
        : nsenterArgv(namespaceTargetOf(turn.namespace), turn.namespace.cwd, binary, args);
};
