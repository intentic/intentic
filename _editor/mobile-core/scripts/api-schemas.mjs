#!/usr/bin/env node
// Writes src/wire/api.schema.json: the JSON Schema of every platform call src/wire/ types, so `cargo test` can hold the
// hand-written Rust to the platform's own shapes as it holds the daemon's to contract.lock.json. The api-contract keeps
// no lock of its own; this is the slice of one the app needs, serialized the way contract-lock.ts serializes the
// sandbox's (zod's toJSONSchema, keys sorted, the dialect banner dropped, one line per entry).
//
// Each entry is one call: its method, its path from the API origin, and the schema of its input and of its output.
// The oRPC procedures come from the api-contract's built dist; Better Auth's sign-in routes from the plugins the
// platform installs, which carry their request bodies as zod (their answers are not zod, so they have no entry).
//
//   node _editor/mobile-core/scripts/api-schemas.mjs [--check]
//
// Reads dist, not src: build the api-contract first (`pnpm --filter @intentic/api-contract build`). --check fails
// when the committed file differs from what the contract says now.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoRoot } from "../../../_tools/constants/src/node.mjs";

const repo = repoRoot(import.meta.url);
const at = (path) => pathToFileURL(join(repo, path));
const load = async (path) => {
    try {
        return await import(at(path).href);
    } catch (error) {
        console.error(`could not load ${path}: build it first (${error.message})`);
        process.exit(2);
    }
};

const { apiContract, API_BASE_PATH } = await load("_shared/api-contract/dist/index.js");
const { serializeLock } = await load("_shared/sandbox-contract/dist/state/contract-lock.js");
const { z } = await load("_shared/api-contract/node_modules/zod/index.js");
const plugins = await load("_platform/api/node_modules/better-auth/dist/plugins/index.mjs");
const betterAuthApi = await load("_platform/api/node_modules/better-auth/dist/api/index.mjs");

// The procedures src/wire/platform.rs declares an Endpoint for.
const PROCEDURES = [
    "me.get",
    "me.signInOptions",
    "sandbox.list",
    "sandbox.identityAssertion",
    "sandbox.ownerTicket",
    "sandbox.wake",
    "desktop.handoff",
    "desktop.redeem",
    "push.register",
    "push.unregister",
];

// Where the platform mounts Better Auth, read off its own configuration rather than spelled a second time here.
const authSource = readFileSync(at("_platform/api/src/auth.ts"), "utf8");
const AUTH_BASE = /basePath:\s*"([^"]+)"/.exec(authSource)?.[1];
if (AUTH_BASE === undefined) {
    console.error("could not find Better Auth's basePath in _platform/api/src/auth.ts");
    process.exit(2);
}

// Better Auth's routes src/wire/auth.rs declares, by the name the entry takes, from the endpoint objects the plugins
// build. The plugins' options are the least that constructs them; nothing here runs a route.
const emailCodes = plugins.emailOTP({ sendVerificationOTP: async () => {} }).endpoints;
const AUTH_ROUTES = {
    "auth.sendEmailCode": emailCodes.sendVerificationOTP,
    "auth.signInEmailCode": emailCodes.signInEmailOTP,
    "auth.googleSignIn": plugins.oneTap().endpoints.oneTapCallback,
    "auth.verifyOneTimeToken": plugins.oneTimeToken().endpoints.verifyOneTimeToken,
    "auth.signOut": betterAuthApi.signOut,
};

// contract-lock.ts's own canonical order (its `sorted` is not exported): keys sorted, arrays as zod ordered them.
const sorted = (value) => {
    if (Array.isArray(value)) {
        return value.map(sorted);
    }
    if (value instanceof Object) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, sorted(value[key])]),
        );
    }
    return value;
};
const schemaOf = (schema) => {
    const json = sorted(z.toJSONSchema(schema, { unrepresentable: "any" }));
    delete json["$schema"];
    return json;
};

const entries = {};
for (const name of PROCEDURES) {
    const [group, key] = name.split(".");
    const procedure = apiContract[group]?.[key]?.["~orpc"];
    if (procedure === undefined) {
        throw new Error(`the api-contract has no procedure ${name}`);
    }
    const entry = { method: procedure.route.method, path: `${API_BASE_PATH}${procedure.route.path}` };
    if (procedure.inputSchema !== undefined) {
        entry.input = schemaOf(procedure.inputSchema);
    }
    if (procedure.outputSchema !== undefined) {
        entry.output = schemaOf(procedure.outputSchema);
    }
    entries[name] = entry;
}
for (const [name, endpoint] of Object.entries(AUTH_ROUTES)) {
    if (endpoint?.path === undefined) {
        throw new Error(`Better Auth no longer builds the route behind ${name}`);
    }
    const entry = { method: endpoint.options.method, path: `${AUTH_BASE}${endpoint.path}` };
    if (endpoint.options.body !== undefined) {
        entry.input = schemaOf(endpoint.options.body);
    }
    entries[name] = entry;
}

const text = serializeLock(sorted(entries));
const target = fileURLToPath(new URL("../src/wire/api.schema.json", import.meta.url));
if (process.argv.includes("--check")) {
    // A missing file is as stale as a different one.
    const committed = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (committed !== text) {
        console.error(`${target} is stale: run node _editor/mobile-core/scripts/api-schemas.mjs`);
        process.exit(1);
    }
} else {
    writeFileSync(target, text);
    console.log(`api.schema.json: ${Object.keys(entries).length} calls`);
}
