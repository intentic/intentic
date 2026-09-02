import type { AdmissionRule, CommandClass } from "@intentic/sandbox-contract";
import type { IconName, PickerOption } from "@intentic/ui";

/* THE WORDS THE SAFETY TAB SETS `commandRules` IN, and the mapping between them and what is actually stored.
 *
 * The stored rulebook is `Partial<Record<CommandClass, AdmissionRule>>`: six keys, three verdicts, and a key
 * that is simply ABSENT. A control offering three options would have to put that absence somewhere, and every
 * place to put it is a lie — which is the whole reason this module exists rather than a three-option enum
 * inlined in the template.
 *
 * ABSENT IS NOT `allow`, and on three of the six classes it is not even close (sandbox/src/guard/actions.ts,
 * `commandRun`):
 *
 *   system.destructive  absent ⇒ HELD. It is the contract's one FLOOR_CLASS, so a sandbox nobody has
 *                       configured still stops before formatting a disk. Drawing that as "Allow" would show a
 *                       green row over a gate that is closed.
 *   files.destructive   absent ⇒ held ONLY in a turn that has taken in outside content (a visitor's message, a
 *                       fetched page, a foreign MCP server). An explicit `allow` switches that off.
 *   secrets.access      absent ⇒ the same, and only when the same command ALSO leaves the sandbox.
 *
 * That last pair is the one that matters and the one a three-option control would silently destroy: both
 * floors are written `rule === undefined && …`, so choosing "Always allow" on either class does not merely
 * restate today's behaviour — it turns the outside-content hold off. A user cannot be asked to infer that from
 * a pill, so `Default` is a real, selectable, fourth posture, and `allowCost` below is the sentence the row
 * shows the moment someone leaves it.
 *
 * The class list, the verdicts and the floors all live in @intentic/sandbox-contract, which both enforcement
 * points read. What is added here is only the vocabulary: a title a person recognises, the commands they will
 * actually have typed, and what "leave it alone" does per class. No behaviour is restated — every sentence
 * below describes a branch of `commandRun`, and if that function moves these move with it. */

/** The four things a row can say, `default` being the absence of a stored key rather than a verdict. */
export type Posture = "default" | AdmissionRule;

export interface CommandRuleRow {
    readonly commandClass: CommandClass;
    readonly icon: IconName;
    /** What the class IS, as a person would name it. `COMMAND_CLASS_LABELS` is the daemon's phrasing for the
     *  middle of a refusal sentence ("commands that rewrite or discard git history"), which reads as a fragment
     *  standing on its own as a row title. */
    readonly title: string;
    /** The commands somebody will recognise. Shown in the row's own type, because the reader's question here is
     *  "does this cover the thing I am worried about", and a class name never answers it. */
    readonly examples: string;
    /** What leaving this row on `Default` actually does — one branch of `commandRun`, in a sentence. */
    readonly whenDefault: string;
    /** What choosing `allow` GIVES UP, where that is more than "it stops asking". Only the two taint classes
     *  have one; everything else's `allow` is what absence already did. */
    readonly allowCost?: string;
}

/* Ordered by consequence, not alphabetically and not by the enum's own order: this is a list somebody scans
 * downward until they reach the first row they care about, and the row they care about first is the one nothing
 * undoes. The three tail rows are the recoverable-but-outward ones — a bad publish and a stray request are both
 * survivable, they are just survivable in public. */
export const COMMAND_RULE_ROWS: readonly CommandRuleRow[] = [
    {
        commandClass: `system.destructive`,
        icon: `eraser`,
        title: `Wipe a disk or a volume`,
        examples: `rm -rf /, mkfs, dd of=/dev/…, docker volume rm`,
        whenDefault: `Asks you first. This is the one kind the sandbox stops on its own, because nothing here brings the machine back.`,
    },
    {
        commandClass: `files.destructive`,
        icon: `trash`,
        title: `Delete files recursively`,
        examples: `rm -rf build, fs.rm(path, { recursive: true })`,
        whenDefault: `Runs — this is ordinary work in a disposable container. Unless the turn has read something from outside; then it asks.`,
        allowCost: `Also stops asking in a turn that has read outside content — a visitor's message, a fetched page, a foreign tool. That hold is the one that catches a deletion somebody else's text talked the agent into.`,
    },
    {
        commandClass: `git.destructive`,
        icon: `history`,
        title: `Rewrite or discard git history`,
        examples: `git push --force, git reset --hard, git clean -f, branch -D`,
        whenDefault: `Runs. What it discards is usually recoverable from a remote or a reflog.`,
    },
    {
        commandClass: `secrets.access`,
        icon: `key`,
        title: `Read credentials`,
        examples: `cat .env, a private key, ~/.aws/credentials, {{secret:NAME}}`,
        whenDefault: `Runs, and what comes back is masked before the model sees it. Unless the turn has read outside content and the same command also leaves the sandbox; then it asks.`,
        allowCost: `Also stops asking when a tainted turn reads a credential in the same command that sends one out — the shape this class is actually about.`,
    },
    {
        commandClass: `package.publish`,
        icon: `cloud-upload`,
        title: `Publish or release a package`,
        examples: `npm publish, cargo publish, gh release create, docker push`,
        whenDefault: `Runs. Nothing here unpublishes it, but the registry is somebody else's to answer to.`,
    },
    {
        commandClass: `network.outbound`,
        icon: `globe`,
        title: `Reach out to the internet`,
        examples: `curl, wget, to any non-local address`,
        whenDefault: `Runs. Holding it would ask about most of the agent's ordinary work.`,
    },
];

/* THE POSTURES, AS SENTENCES. `hint` rather than `description` because <Picker> truncates a description at the
 * right edge of the row and these have to be read to the end — the difference between "Ask me" and "Never" on
 * an automation's turn is the last clause of its hint, and it is the thing people get wrong. */
const POSTURE_OPTIONS: readonly PickerOption<Posture>[] = [
    {
        value: `default`,
        label: `Default`,
        icon: `circle`,
        // Filled in per row: "the default" is a different thing on three of these six classes, which is the
        // entire premise of this module.
        hint: ``,
    },
    {
        value: `allow`,
        label: `Always allow`,
        icon: `check-circle`,
        hint: `Runs without asking, every time, including in a turn that has read content from outside.`,
    },
    {
        value: `hold`,
        label: `Ask me`,
        icon: `lock`,
        hint: `Holds the command and raises a card in the chat. A turn nobody is watching — an automation, a schedule — is refused instead and told why, because "ask me" cannot mean anything when there is no me.`,
    },
    {
        value: `deny`,
        label: `Never`,
        icon: `times`,
        hint: `Refused outright. The agent is told which rule stopped it and carries on with the rest of its work.`,
    },
];

/** This row's four options, with `Default` wearing the sentence that says what it does HERE. */
export const postureOptions = (row: CommandRuleRow): readonly PickerOption<Posture>[] =>
    POSTURE_OPTIONS.map((option) => (option.value === `default` ? { ...option, hint: row.whenDefault } : option));

/** What the stored rulebook says about one class, as a posture. An absent key is `default`, never `allow`. */
export const postureOf = (rules: Partial<Readonly<Record<CommandClass, AdmissionRule>>> | undefined, commandClass: CommandClass): Posture =>
    rules?.[commandClass] ?? `default`;

/* The rulebook this row's new posture produces. `default` DELETES the key rather than storing a fourth verdict:
 * the schema has three, and the floors in `commandRun` key on the key being absent, so a stored "default" would
 * be a value nothing reads and the floors would never fire again. */
export const withPosture = (
    rules: Partial<Readonly<Record<CommandClass, AdmissionRule>>>,
    commandClass: CommandClass,
    posture: Posture,
): Partial<Record<CommandClass, AdmissionRule>> => {
    const next: Partial<Record<CommandClass, AdmissionRule>> = { ...rules };
    if (posture === `default`) {
        delete next[commandClass];
    } else {
        next[commandClass] = posture;
    }
    return next;
};

/* The line under a row, or nothing. Two cases, and they are the two a pill cannot carry:
 *
 *   default  what "leave it alone" resolves to, which differs per class and is the fact somebody opening this
 *            page has come for. Shown always, not on hover: it is the current state of the row.
 *   allow    what was just given up, on the two classes where `allow` is more than the absence of a rule.
 *
 * `hold` and `deny` say themselves — the pill is the whole story — so they get no line, which is also what
 * keeps the six rows from becoming six paragraphs. */
export const postureNote = (row: CommandRuleRow, posture: Posture): { readonly text: string; readonly warn: boolean } | undefined => {
    if (posture === `default`) {
        return { text: row.whenDefault, warn: false };
    }
    return posture === `allow` && row.allowCost !== undefined ? { text: row.allowCost, warn: true } : undefined;
};
