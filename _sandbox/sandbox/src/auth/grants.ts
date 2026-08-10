import { sandboxRouteAllowed } from "@intentic/extension-manifest";
import { tokenEquals } from "./auth.js";
import { type ControlTokens, controlScoped } from "./control-tokens.js";

/* GRANTS — every credential the daemon accepts INSTEAD OF the owner's Google bearer, in one table.
 *
 * There are four, written months apart, and each answered the same three questions in its own way: is this
 * header present, may a holder of this kind reach this route, is the secret real. They diverged the way
 * copies do — two checked scope with a pure function, one inline, and the panel branch never asked at all,
 * which was not a decision so much as the question nobody wrote down that time. A wrong panel token also fell
 * THROUGH to the bearer check while the other three answered 401, so the same mistake had two outcomes
 * depending on which credential you got wrong.
 *
 * The table fixes the shape rather than the four instances: a grant cannot exist without saying what it
 * reaches, and every grant fails the same way.
 *
 * ONE RULE WORTH KNOWING: a non-empty header SELECTS a grant and commits the request to it. Presenting a bad
 * secret is 401 — never a quiet fall-through to whatever might authorize behind it. The empty-string check is
 * load-bearing and not defensive noise: `tokenEquals("", "")` is true, so a composition that ever produced an
 * empty secret would turn every unauthenticated request into a call by that holder.
 */

export type GrantVerdict = "ok" | "unauthorized" | "out-of-scope";

export interface Grant {
    // The header the holder presents its secret in.
    readonly header: string;
    // How a refusal names it ("bridge token", "sync token") — the credential's name, not the header's, because
    // the person reading the error is holding the former.
    readonly name: string;
    readonly authorize: (presented: string, method: string, path: string) => Promise<GrantVerdict>;
}

/* The shape three of the four share: one secret fixed for the daemon's lifetime, one static allowlist.
 *
 * Scope is checked BEFORE the secret here, deliberately. The two failures have different fixes — "this
 * credential may not go there" versus "your token is wrong" — and a holder of the right token hitting the
 * wrong route should be told which one it is. (The control grant below cannot do this, and says why.) */
const fixedSecretGrant = (header: string, name: string, reaches: (method: string, path: string) => boolean, secret: string): Grant => ({
    header,
    name,
    authorize: async (presented, method, path) => {
        if (!reaches(method, path)) {
            return "out-of-scope";
        }
        return tokenEquals(presented, secret) ? "ok" : "unauthorized";
    },
});

// The `vpn` and `otp` CLIs on the agent's PATH (and in the owner's terminals) reach the daemon over loopback
// with the per-boot agent token. Scoped hard: the agent may dial and drop the tunnels the owner configured and
// may mint one-time codes off a stored TOTP seed — each derived, expiring within its period — and may never
// read /secrets or /capabilities themselves, which would hand it the credentials behind them.
const agentReach = (method: string, path: string): boolean =>
    path === "/vpn" || path.startsWith("/vpn/") || (method === "GET" && /^\/capabilities\/[^/]+\/otp$/.test(path));

/* The WIDE grant — a panel's backend is server-side code running inside this container that legitimately acts
 * as the app, and a panel is open-ended (an operator UI the owner or the agent wrote), so enumerating what one
 * may call would be guessing at somebody else's app. It stays broad on purpose.
 *
 * ONE CARVE-OUT, and it is the route that hands back stored credentials. `/capabilities/<id>/connection`
 * serves EXTENSION BACKENDS — its whole gate is "no signed-in identity", because the extension token is the
 * only grant that must also declare the route. A panel token also carries no identity, so it satisfied that
 * gate by accident and could read any connected account's config, secrets included: the browser password and
 * the TOTP seed that accounts-tools.ts and the manifest's TOTP rule promise never to hand over. And unlike the
 * extension token, this one is injected into every panel and connector process in the container, where
 * anything that can read /proc can lift it.
 *
 * Written as a denied route rather than an allowlist because that is what the grant IS — everything, except
 * the one door that was never meant for it. An allowlist here would be a fiction the next panel breaks.
 */
const CONNECTION_READ = /^\/capabilities\/[^/]+\/connection$/;
const panelReach = (_method: string, path: string): boolean => !CONNECTION_READ.test(path);

/* The desktop-sync agent's two routes, and it is worth saying why there are two rather than one.
 *
 * It READS the listening-ports list — what port mirroring is driven from (`intentic-sync mirror` reconciles
 * Mutagen forwards against it). Still read-only in the sense that matters: not the ports MUTATIONS, so the agent
 * can learn which ports exist and can never forward one publicly.
 *
 * It WRITES one thing: its own machine report — the folders it syncs into, the ports it got onto localhost, and
 * whether its watcher is alive. That is the half of desktop sync the sandbox has never been able to see (SYNC_DIR
 * is local agent state and never reaches the daemon), so the Desktop sync card could only ever claim a machine
 * was enrolled and point the user at `intentic-sync status` on a terminal for the rest.
 *
 * The write grants nothing back: the report is stored in memory, filed under the enrollment whose token presented
 * it rather than under any name the body claims, and read back only by this sandbox's own collaborators. It does
 * not widen what the agent can LEARN by a single route. */
const syncReach = (method: string, path: string): boolean =>
    (method === "GET" && path === "/ports") || (method === "POST" && path === "/system/sync/report");

export interface GrantSources {
    readonly panelToken: string;
    readonly agentToken: string;
    readonly controlTokens: ControlTokens;
    // Passed in rather than imported so this module stays free of platform/ and every grant is testable with
    // a one-line fake.
    readonly verifySync: (presented: string) => Promise<boolean>;
    // An extension backend's minted per-extension token → the manifest's declared `permissions.daemon`
    // (extensions/backend/backend-supervisor.ts). Unknown token ⇒ undefined ⇒ 401.
    readonly verifyExtension: (presented: string) => { readonly permissions: readonly string[] } | undefined;
}

export const grantsOf = ({ panelToken, agentToken, controlTokens, verifySync, verifyExtension }: GrantSources): readonly Grant[] => [
    fixedSecretGrant("x-intentic-panel", "panel token", panelReach, panelToken),
    fixedSecretGrant("x-intentic-agent", "agent token", agentReach, agentToken),
    {
        /* An extension BACKEND's daemon reach — the minted per-extension token its api.daemon presents
         * (extensions/backend/). Scoped to the manifest's `permissions.daemon` in the same glob grammar the
         * UI half's `permissions.sandbox` uses, so a backend's reach into the core is a declared, reviewable
         * list rather than the all-routes grant the panel token gives a panel. Resolve-then-scope like the
         * control grant, and for the same reason: which routes are in reach is stored with the token. */
        header: "x-intentic-extension",
        name: "extension token",
        authorize: async (presented, method, path) => {
            const grant = verifyExtension(presented);
            if (grant === undefined) {
                return "unauthorized";
            }
            return sandboxRouteAllowed(grant.permissions, method, path) ? "ok" : "out-of-scope";
        },
    },
    {
        header: "x-intentic-control",
        name: "control token",
        authorize: async (presented, method, path) => {
            /* Resolve BEFORE scoping, unavoidably: a control token's reach is stored WITH it, so there is no
             * scope to check until we know which token this is. That inverts the order the grants above use,
             * and the inversion is free — it also leaks less, since an unknown token now gets the same answer
             * for every route instead of a map of which ones exist. */
            const scope = await controlTokens.scopeOf(presented);
            if (scope === undefined) {
                return "unauthorized";
            }
            return controlScoped(scope, method, path) ? "ok" : "out-of-scope";
        },
    },
    {
        header: "x-intentic-sync",
        name: "sync token",
        authorize: async (presented, method, path) => {
            if (!syncReach(method, path)) {
                return "out-of-scope";
            }
            return (await verifySync(presented)) ? "ok" : "unauthorized";
        },
    },
];
