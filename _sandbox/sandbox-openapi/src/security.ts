/* HOW A CALL IS AUTHORIZED, which is the one part of the daemon's surface the contract does not carry.
 *
 * `oc.route` describes a route's shape, not its gate: the gate is Hono middleware in the daemon's app.ts, and
 * a generated document that says nothing about it documents 255 calls a reader cannot make. So the schemes
 * below are authored, and they are authored HERE rather than in the site's prose because they belong to the
 * daemon, not to a page about it: an editor bridge or a CLI reading this document should learn how to
 * authenticate from the document.
 *
 * TWO CREDENTIALS, FOR TWO KINDS OF CALLER, and the split is the daemon's own (auth/control-tokens.ts):
 *
 *   A PERSON holds a session, minted by signing in through the browser, presented as a bearer token. It
 *   reaches everything the owner reaches, because it IS the owner.
 *
 *   A PROGRAM holds a control token, minted by the owner with a scope chosen at that moment, presented in
 *   `x-intentic-control`. Scope is stored WITH the token rather than derived from the caller, because the
 *   daemon cannot tell an editor from a CLI from a CI job — they are all "a program holding a secret", so the
 *   only honest moment to decide how far one reaches is when a person mints it.
 *
 * The scope ladder widens downward EXCEPT `editor`, which is its own narrow slice rather than a rung: an
 * editor bridge has no business reading the fleet, and saying so costs one row.
 */

import { CONTROL_SCOPE_REACH } from "@intentic/sandbox-contract";

/* The scope ladder is the contract's (control-scopes.ts), re-exported here so the site's authorisation page and
 * this document's security scheme read the same rows the daemon and the app do. */
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

/* One requirement for the whole document rather than per operation, because that is the truth: every route
 * here accepts either credential, and the difference between them is SCOPE, which an OpenAPI security
 * requirement cannot express per route without inventing a fake scope model. The scopes are documented on the
 * scheme above, where a reader looks once, instead of being restated 255 times as if the generator knew. */
export const securityRequirement = (): Record<string, never[]>[] => [{ session: [] }, { control: [] }];
