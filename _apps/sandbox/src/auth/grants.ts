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

// The `vpn` CLI on the agent's PATH (and in the owner's terminals) reaches the daemon over loopback with the
// per-boot agent token. Scoped hard: the agent may dial and drop the tunnels the owner configured, and may
// never read /secrets or /capabilities, which would hand it the credentials behind them.
const vpnReach = (_method: string, path: string): boolean => path === "/vpn" || path.startsWith("/vpn/");

// The one WIDE grant, listed with an explicit always-true reach rather than left out of the table so that
// "this one is unscoped" reads as a line somebody chose. A panel's backend is server-side code running inside
// this container that legitimately acts as the app; its token is injected into panel processes as
// INTENTIC_PANEL_TOKEN and never reaches a browser.
const panelReach = (): boolean => true;

// The desktop-sync agent reads the listening-ports list — the ONE route port mirroring needs
// (`intentic-sync mirror` drives Mutagen forwards from it). Read-only by design: not even the ports mutations.
const syncReach = (method: string, path: string): boolean => method === "GET" && path === "/ports";

export interface GrantSources {
    readonly panelToken: string;
    readonly agentToken: string;
    readonly controlTokens: ControlTokens;
    // Passed in rather than imported so this module stays free of platform/ and every grant is testable with
    // a one-line fake.
    readonly verifySync: (presented: string) => Promise<boolean>;
}

export const grantsOf = ({ panelToken, agentToken, controlTokens, verifySync }: GrantSources): readonly Grant[] => [
    fixedSecretGrant("x-intentic-panel", "panel token", panelReach, panelToken),
    fixedSecretGrant("x-intentic-agent", "agent token", vpnReach, agentToken),
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
