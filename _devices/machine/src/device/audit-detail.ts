import type { McpAuditEntry } from "@intentic/sandbox-contract/peer-mcp-server";

// Arguments are logged verbatim except typed text, which is redacted to its length: a `device` or `android_act` "type",
// `clipboard` "write" or `ui_act` set_value call routinely carries a password. A key combination is not redacted; there is nothing
// in it to leak. A `password` (os_wifi_connect's), a runner `token` (ci_runner_register's, _remove's) and deploy_stack's
// rendered `env` and `registries` (2026-11-25) are too, each logged as how much it held.
export const auditDetail = (name: string, args: McpAuditEntry["args"]): string => {
    const redact =
        ((name === "device" || name === "android_act") && args["action"] === "type") ||
        (name === "clipboard" && args["action"] === "write") ||
        name === "browser_fill";
    const typed = redact
        ? { ...args, text: `<${String(args["text"] ?? "").length} characters>` }
        : name === "ui_act" && args["value"] !== undefined
          ? { ...args, value: `<${String(args["value"]).length} characters>` }
          : args;
    const secret = (key: string): boolean => key === "password" || key === "token" || (name === "deploy_stack" && (key === "env" || key === "registries"));
    const safe = Object.fromEntries(
        Object.entries(typed).map(([key, value]) => [key, secret(key) ? `<${Array.isArray(value) ? `${value.length} entries` : `${String(value).length} characters`}>` : value]),
    );
    return JSON.stringify(safe).slice(0, 500);
};
