import { createHash } from "node:crypto";
// The subpath, not the package root: the root loads every schema in the contract, which `m365` never needs.
import { envSuffix } from "@intentic/sandbox-contract/capability-env";

// One connected Microsoft 365 card, as the per-instance env vars (or the listener's state route) carry it.
export interface Account {
    id: string;
    tenantId: string;
    clientId: string;
    clientSecret?: string;
    refreshToken?: string;
    authority?: string;
    access?: string;
    // Moves on every interactive sign-in: whose mailbox the token belongs to may have changed with it.
    signedInAt?: string;
}

// Microsoft's clouds, each one sign-in host paired with one Graph host. The card offers only these, and the pair is fixed
// here rather than typed twice, so a token minted in one cloud is never sent to another.
const CLOUDS = new Map([
    ["login.microsoftonline.com", "graph.microsoft.com"],
    ["login.microsoftonline.us", "graph.microsoft.us"],
    ["login.chinacloudapi.cn", "microsoftgraph.chinacloudapi.cn"],
]);
export const DEFAULT_AUTHORITY = "login.microsoftonline.com";

export interface Cloud {
    readonly authority: string;
    readonly graph: string;
}

export const cloudOf = (account: Account): Cloud => {
    const authority = account.authority || DEFAULT_AUTHORITY;
    const graph = CLOUDS.get(authority);
    if (graph === undefined) {
        throw new Error("Unsupported Microsoft sign-in cloud: pick one on the Microsoft 365 card");
    }
    if (!/^[a-zA-Z0-9.-]+$/.test(account.tenantId) || !account.clientId) {
        throw new Error("Set the directory (tenant) ID and application (client) ID on the Microsoft 365 card");
    }
    return { authority, graph };
};

const isReadOnly = (account: Account): boolean => account.access === "read";

// Read only asks Microsoft for read permissions too, so the token itself cannot write even if a check here were missed.
export const scopesFor = (account: Account): string => {
    const { graph } = cloudOf(account);
    const permissions = isReadOnly(account)
        ? ["User.Read", "Mail.Read", "Calendars.Read", "Files.Read.All", "Sites.Read.All"]
        : ["User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite", "Files.ReadWrite.All", "Sites.Read.All"];
    return ["offline_access", ...permissions.map((scope) => `https://${graph}/${scope}`)].join(" ");
};

export const assertWrite = (account: Account): void => {
    if (isReadOnly(account)) {
        throw new Error("This Microsoft 365 connection is read-only: switch it to Read & write on its card, then sign in again");
    }
};

// What the card held when its token was minted; the daemon refuses to store a token once any of these has changed.
// A type rather than an interface: the daemon's route takes it as a plain record of field values.
export type Binding = {
    readonly tenantId: string;
    readonly clientId: string;
    readonly authority: string;
    readonly access: string;
};

export const bindingOf = (account: Account): Binding => ({
    tenantId: account.tenantId,
    clientId: account.clientId,
    authority: account.authority || DEFAULT_AUTHORITY,
    access: account.access || "write",
});

// A short stable name for one sign-in: who the token was issued to and when. Never the token itself.
export const signInKey = (account: Account): string =>
    createHash("sha256")
        .update(JSON.stringify([account.tenantId, account.clientId, account.authority || DEFAULT_AUTHORITY, account.signedInAt ?? ""]))
        .digest("hex")
        .slice(0, 16);

const PREFIX = "M365_TENANT_ID_";
export const accountsFrom = (env: NodeJS.ProcessEnv): Account[] =>
    Object.keys(env)
        .filter((key) => key.startsWith(PREFIX))
        .map((key) => {
            const suffix = key.slice(PREFIX.length);
            const get = (name: string): string => env[`M365_${name}_${suffix}`] ?? "";
            return {
                id: suffix.toLowerCase(),
                tenantId: get("TENANT_ID"),
                clientId: get("CLIENT_ID"),
                clientSecret: get("CLIENT_SECRET"),
                refreshToken: get("REFRESH_TOKEN"),
                authority: get("AUTHORITY"),
                access: get("ACCESS"),
            };
        });

export const selectAccount = (accounts: readonly Account[], wanted?: string): Account => {
    const found =
        wanted === undefined ? (accounts.length === 1 ? accounts[0] : undefined) : accounts.find((a) => envSuffix(a.id) === envSuffix(wanted));
    if (found === undefined) {
        throw new Error(
            accounts.length === 0
                ? "No Microsoft 365 account is connected: add the Microsoft 365 card under Capabilities"
                : `Several Microsoft 365 accounts are connected: pass --account with one of ${accounts.map((a) => a.id).join(", ")}`,
        );
    }
    return found;
};
