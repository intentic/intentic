// Authorization is Hono middleware in app.ts, not oc.route, so it's authored here. Two credentials: a person's session
// (bearer, reaches everything the owner does) and a program's control token (`x-intentic-control`), scope fixed at mint
// time since the daemon can't tell callers apart.

import { CONTROL_SCOPE_REACH } from "@intentic/sandbox-contract";

// Re-exported from the contract so the site's auth page and this scheme read the same rows as the daemon.
export { CONTROL_SCOPE_REACH };

export const securitySchemes = (): Record<string, unknown> => ({
    session: {
        type: "http",
        scheme: "bearer",
        description:
            "A signed-in person's session, minted by `POST /system/session` and presented as `authorization: Bearer …`. It reaches everything the owner reaches.",
    },
    control: {
        type: "apiKey",
        in: "header",
        name: "x-intentic-control",
        description: [
            "A program's credential, minted by the owner with a scope fixed at that moment. The raw `ict_…` value is returned exactly once; only its hash is stored, and it can be revoked per token.",
            "",
            "Scopes, widening downward:",
            ...CONTROL_SCOPE_REACH.map((entry) => `- \`${entry.scope}\` — ${entry.reach} ${entry.note}`),
        ].join("\n"),
    },
});

// One requirement for the whole document: every route accepts either credential, and OpenAPI can't express per-route
// scope without a fake model; scopes are documented on the scheme instead.
export const securityRequirement = (): Record<string, never[]>[] => [{ session: [] }, { control: [] }];
