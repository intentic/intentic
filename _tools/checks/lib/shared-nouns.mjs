// Whether a `shared.*` message reads as a noun phrase (or the state a thing is in), which is all the section may hold:
// a word every feature says with the same meaning. A verb has its own home (`ui.action.*`), and anything that only
// means something inside the sentence around it belongs to the feature that writes that sentence.
//
// English grammar cannot be decided by a regex, so this refuses only the shapes that are never a noun phrase:
// - a key ending in a digit: a numbered twin (`sandbox2`) whose name hides what makes it differ from the original;
// - a placeholder: a message with a hole in it is a sentence some feature fills, not a word;
// - punctuation or a space at either edge (`, temporary`, `…and`): a fragment spliced into a sentence;
// - a conjunction (`and`, `or`): it joins two things, so it is never one;
// - a personal pronoun (`you`, `it`): who it means is decided by the sentence around it. A possessive determiner
//   (`Your connections`) heads a noun phrase and passes;
// - an imperative from IMPERATIVES first: an order is a verb, which `ui.action.*` holds;
// - a message spelled exactly like one of the kit's `ui.action.*` messages: that word already has a home as a verb.

const CONJUNCTIONS = new Set(["and", "or", "but", "nor", "&"]);
const PRONOUNS = new Set(["i", "me", "you", "he", "him", "she", "it", "we", "us", "they", "them"]);
// Only verbs English does not also use as a noun or a state, so the rule never takes one for an order: "Open" (a
// state), "Run", "View", "Update", "Copy", "Start", "Check", "Edit" and "Download" are left off on purpose.
const IMPERATIVES = new Set([
    "add",
    "apply",
    "approve",
    "browse",
    "cancel",
    "choose",
    "connect",
    "continue",
    "create",
    "delete",
    "disable",
    "discard",
    "disconnect",
    "dismiss",
    "enable",
    "hide",
    "invite",
    "paste",
    "pick",
    "publish",
    "reconnect",
    "refresh",
    "reload",
    "remove",
    "rename",
    "restart",
    "restore",
    "retry",
    "revoke",
    "save",
    "select",
    "send",
    "show",
    "sign",
    "skip",
    "try",
    "undo",
    "uninstall",
]);

// `{'…'}` is vue-i18n's literal syntax, not a hole.
const PLACEHOLDER = /\{\s*(?!')[^}]*\}/;
const RAGGED_EDGE = /^[\s,;:.…·—–-]|[\s,;:.…·—–-]$/;
const words = (message) => message.toLowerCase().match(/[\p{L}&]+/gu) ?? [];

/** Why `key` (under `shared.`) holding `message` is not a noun phrase; empty when it is. `actions` are the kit's verbs. */
export const notANoun = (key, message, actions = []) => {
    const said = words(message);
    const reasons = [];
    if (/\d$/.test(key)) {
        reasons.push("its key ends in a digit: name what makes it differ from the key it copies");
    }
    if (PLACEHOLDER.test(message)) {
        reasons.push("it has a placeholder, so it is a sentence the feature that fills it owns");
    }
    if (RAGGED_EDGE.test(message)) {
        reasons.push("punctuation or a space at its edge makes it a fragment of someone's sentence");
    }
    const conjunction = said.find((word) => CONJUNCTIONS.has(word));
    if (conjunction !== undefined) {
        reasons.push(`"${conjunction}" is a conjunction`);
    }
    const pronoun = said.find((word) => PRONOUNS.has(word));
    if (pronoun !== undefined) {
        reasons.push(`"${pronoun}" is a pronoun, whose meaning the sentence around it decides`);
    }
    if (said.length > 0 && IMPERATIVES.has(said[0])) {
        reasons.push(`it opens with the verb "${said[0]}": a verb goes to ui.action.*`);
    }
    const lower = message.trim().toLowerCase();
    if (actions.some((action) => action.trim().toLowerCase() === lower)) {
        reasons.push("the kit already says it as a verb in ui.action.*");
    }
    return reasons;
};

/**
 * One finding per `shared` message that is not a noun phrase and is not excused, plus one per excuse that no longer
 * excuses anything (its key gone, or its message now passing) or gives no reason.
 */
export const sharedFindings = (shared, actions, allowed) => {
    const findings = [];
    for (const [key, message] of Object.entries(shared)) {
        // A catalog is parsed JSON, so anything that is not a string is a group.
        if (message instanceof Object) {
            findings.push(`shared.${key}: a nested group; shared.* is a flat list of words`);
            continue;
        }
        const reasons = notANoun(key, message, actions);
        if (reasons.length > 0 && allowed[`shared.${key}`] === undefined) {
            findings.push(`shared.${key} "${message}": ${reasons.join("; ")}`);
        }
    }
    for (const [key, reason] of Object.entries(allowed)) {
        const message = shared[key.replace(/^shared\./, "")];
        if (reason.trim() === "") {
            findings.push(`${key}: allowed without a reason`);
        } else if (message === undefined || message instanceof Object || notANoun(key.replace(/^shared\./, ""), message, actions).length === 0) {
            findings.push(`${key}: allowed, but it no longer needs to be (delete the entry)`);
        }
    }
    return findings;
};
