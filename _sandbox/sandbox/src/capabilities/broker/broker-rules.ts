import type { BrokerRule } from "@intentic/extension-manifest";

// What a brokered credential may do once it is on the right host: method and path rules, checked by the gateway on every
// request it would attach the credential to. A connector declares defaults (its manifest's `broker.rules`); the owner's
// own rules for a card, kept off the workspace beside the vault, replace them whole. The first rule that covers a request
// decides; a request no rule covers is allowed, so a card with no rules behaves as a plain credential on its hosts.

export type RuleVerdict =
    | { readonly action: "allow"; readonly rule?: number }
    | { readonly action: "ask" | "deny"; readonly rule: number; readonly why: string | undefined };

// A path's segments, empty ones dropped so `/a//b/` reads as `/a/b`; a percent-encoded slash stays inside its segment,
// which is the service's own reading of it too.
const segmentsOf = (path: string): string[] => path.split("/").filter((segment) => segment !== "");

// `*` is one whole segment, `**` any number (zero included); anything else matches its segment exactly, case and all,
// since a service's own routing is.
const matchSegments = (pattern: readonly string[], path: readonly string[]): boolean => {
    const [head, ...rest] = pattern;
    if (head === undefined) {
        return path.length === 0;
    }
    if (head === "**") {
        for (let skip = 0; skip <= path.length; skip += 1) {
            if (matchSegments(rest, path.slice(skip))) {
                return true;
            }
        }
        return false;
    }
    const [segment, ...after] = path;
    return segment !== undefined && (head === "*" || head === segment) && matchSegments(rest, after);
};

export const pathMatches = (pattern: string, path: string): boolean => matchSegments(segmentsOf(pattern), segmentsOf(path));

const covers = (rule: BrokerRule, method: string, path: string): boolean =>
    (rule.methods === undefined || rule.methods.includes(method.toUpperCase())) &&
    (rule.paths === undefined || rule.paths.some((pattern) => pathMatches(pattern, path)));

/** The decision for one request: `path` is below the route's upstream, without the query. */
export const evaluateRules = (rules: readonly BrokerRule[], method: string, path: string): RuleVerdict => {
    const index = rules.findIndex((rule) => covers(rule, method, path));
    const rule = rules[index];
    if (rule === undefined) {
        return { action: "allow" };
    }
    return rule.action === "allow" ? { action: "allow", rule: index } : { action: rule.action, rule: index, why: rule.why };
};

/** The rules in force for one card: the owner's where written, else the connector's own. */
export const effectiveRules = (owner: readonly BrokerRule[] | undefined, connector: readonly BrokerRule[] | undefined): readonly BrokerRule[] =>
    owner ?? connector ?? [];
