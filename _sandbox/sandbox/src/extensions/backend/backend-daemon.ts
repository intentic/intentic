import type { ExtensionServerApi } from "@intentic/extension-api";
import { sandboxRouteAllowed } from "@intentic/extension-manifest";
import { sandboxAnswerSchema, sandboxContract, sandboxRequestFor } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { type BackendHostExtension, EXTENSION_TOKEN_HEADER } from "./backend-host-config.js";

// One extension's `api.daemon`, every door presenting its minted grant, which the daemon judges each request by. The
// typed client is also judged here, before anything is sent: on the method and path a call resolves to, against the
// same `permissions.daemon` list, so a refusal names the missing declaration instead of arriving as the daemon's 403.

export const createDaemonApi = (
    daemonUrl: string,
    extension: Pick<BackendHostExtension, "id" | "daemonToken" | "daemonPermissions">,
): ExtensionServerApi["daemon"] => {
    const granted = (init?: RequestInit): Headers => {
        const headers = new Headers(init?.headers);
        headers.set(EXTENSION_TOKEN_HEADER, extension.daemonToken);
        return headers;
    };
    // A procedure this build's contract does not declare is refused too: reaching one means a hand-built path.
    const gate = (procedure: readonly string[], input: unknown): void => {
        const request = sandboxRequestFor(procedure, input);
        if (request === undefined) {
            throw new Error(
                `extension "${extension.id}" called daemon procedure ${procedure.join(".")}, which this build's contract does not declare`,
            );
        }
        if (!sandboxRouteAllowed(extension.daemonPermissions, request.method, request.path)) {
            throw new Error(
                `extension "${extension.id}" called undeclared daemon route ${request.method} ${request.path}: declare it in permissions.daemon in the manifest`,
            );
        }
    };
    return {
        rpc: createORPCClient(
            new OpenAPILink(sandboxContract, {
                url: daemonUrl,
                headers: { [EXTENSION_TOKEN_HEADER]: extension.daemonToken },
                interceptors: [
                    ({ path, input, next }) => {
                        gate(path, input);
                        return next();
                    },
                    async ({ path, next }) => {
                        const answer = await next();
                        const schema = sandboxAnswerSchema(path);
                        return schema === undefined ? answer : schema.parse(answer);
                    },
                ],
            }),
        ),
        request: (path, init) => fetch(`${daemonUrl}${path}`, { ...init, headers: granted(init) }),
        json: async <T>(path: string, init?: RequestInit): Promise<T> => {
            const headers = granted(init);
            if (init?.body !== undefined && !headers.has("content-type")) {
                headers.set("content-type", "application/json");
            }
            const response = await fetch(`${daemonUrl}${path}`, { ...init, headers });
            if (!response.ok) {
                throw new Error(`daemon answered ${response.status} for ${init?.method ?? "GET"} ${path}: ${await response.text()}`);
            }
            return (await response.json()) as T;
        },
    };
};
