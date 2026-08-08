import type { Rule } from "@intentic-app/api-contract";

/* THE RULE TABLE, READ — pure functions over a rule list, with no imports that touch the browser.
 *
 * Split from useRules.ts deliberately and not just tidily: the agent menu, the chat notice and the push dialog
 * each need one of these answers, and none of them wants the queries a composable brings. A module that only
 * knows how to READ rules can be imported anywhere, including from tests that stub the whole sandbox client. */

// The rules whose row lives elsewhere on the tab. Everything else lists. These ids belong to THIS SCREEN, not
// to the wire contract: a rule with a dedicated row is still an ordinary rule to the daemon, and which surface
// chooses to render one nicely is no business of the shared schema.
export const NAMED_RULES = { verify: `verify-edits`, prepush: `pre-push`, land: `auto-land` } as const;

/* --- what the table says when nothing about the occasion is known yet ---------------------------------------
 *
 * Two questions the rest of the app asks about the rules WITHOUT being at the moment they belong to: the agent
 * menu wants this sandbox's landing posture to show on a hold toggle, and the push dialog wants the command it
 * is about to run so it can name it before the first poll answers.
 *
 * Both are answered by resolving with no facts, which is exactly right rather than a shortcut: a conditional
 * rule cannot match something unknown, so what falls out is the first UNCONDITIONAL rule — "what happens by
 * default". That is the honest thing to put on a toggle, and it degrades correctly as conditions are added:
 * the toggle keeps showing the default and the conditional rules stay visible in the list where they were
 * written. Plain functions over a rule list, so a caller that only needs one pays for no queries. */

// Does finished work reach the tree by itself, absent anything specific about a particular agent? No rule ⇒
// held, which is the recoverable answer and the one an empty table has always given.
export const landsByDefault = (rules: readonly Rule[]): boolean => {
    const deciding = rules.find((rule) => rule.enabled && rule.moment === `agent.finished` && rule.when === undefined);
    return deciding?.action.kind === `verdict` && deciding.action.verdict === `allow`;
};

// The command a push would run, for the dialog's own sentence. The FIRST one: it is the one that runs first,
// and it is the one whose name the user is about to watch.
export const prepushCommandOf = (rules: readonly Rule[]): string => {
    for (const rule of rules) {
        if (rule.enabled && rule.moment === `push.starting` && rule.action.kind === `command` && rule.action.command.trim() !== ``) {
            return rule.action.command;
        }
    }
    return ``;
};
