import type { AdmissionRule, CommandClass } from "@intentic/sandbox-contract";
import type { IconName, PickerOption } from "@intentic/ui";

/* The vocabulary for `settings.commandRules`, the gate every shell command is read against
 * (sandbox/src/guard/actions.ts `commandRun`).
 *
 * FOUR POSTURES, NOT THREE. The stored rulebook holds three verdicts and an ABSENT key, and absence is not the
 * same as `allow`: both of the daemon's standing floors are `rule === undefined` branches, so writing an
 * explicit `allow` switches one off. `whenDefault` is what that absence resolves to on each row, and it is why
 * Default is selectable rather than folded into one of the verdicts. */

export type Posture = "default" | AdmissionRule;

export interface CommandRuleRow {
    readonly commandClass: CommandClass;
    readonly icon: IconName;
    readonly title: string;
    /** The commands themselves. They identify the row faster than any sentence about it could. */
    readonly examples: string;
    /** What an unset key does here: "asks" on the floor class, "runs" plus the taint condition where there is one. */
    readonly whenDefault: string;
}

// Ordered by consequence: the row nothing undoes is the row somebody scans for first.
export const COMMAND_RULE_ROWS: readonly CommandRuleRow[] = [
    {
        commandClass: `system.destructive`,
        icon: `eraser`,
        title: `Wipe a disk or a volume`,
        examples: `rm -rf /, mkfs, dd of=/dev/…, docker volume rm`,
        whenDefault: `asks`,
    },
    {
        commandClass: `files.destructive`,
        icon: `trash`,
        title: `Delete files recursively`,
        examples: `rm -rf build, fs.rm(path, { recursive: true })`,
        whenDefault: `runs, asks after outside content`,
    },
    {
        commandClass: `git.destructive`,
        icon: `history`,
        title: `Rewrite or discard git history`,
        examples: `git push --force, git reset --hard, git clean -f`,
        whenDefault: `runs`,
    },
    {
        commandClass: `secrets.access`,
        icon: `key`,
        title: `Read credentials`,
        examples: `cat .env, a private key, ~/.aws/credentials`,
        whenDefault: `runs, asks if it also leaves`,
    },
    {
        commandClass: `package.publish`,
        icon: `cloud-upload`,
        title: `Publish or release a package`,
        examples: `npm publish, cargo publish, docker push`,
        whenDefault: `runs`,
    },
    {
        commandClass: `network.outbound`,
        icon: `globe`,
        title: `Reach out to the internet`,
        examples: `curl, wget, to any non-local address`,
        whenDefault: `runs`,
    },
];

const VERDICTS: readonly PickerOption<Posture>[] = [
    { value: `allow`, label: `Always allow`, icon: `check-circle` },
    // A hold refuses instead in a turn nobody is watching; the gate words that, since it is a property of the
    // turn rather than of the rule.
    { value: `hold`, label: `Ask me`, icon: `lock` },
    { value: `deny`, label: `Never`, icon: `times` },
];

/** The four options, Default annotated with what it resolves to on THIS row. */
export const postureOptions = (row: CommandRuleRow): readonly PickerOption<Posture>[] => [
    { value: `default`, label: `Default`, icon: `circle`, description: row.whenDefault },
    ...VERDICTS,
];

export const postureOf = (rules: Partial<Readonly<Record<CommandClass, AdmissionRule>>> | undefined, commandClass: CommandClass): Posture =>
    rules?.[commandClass] ?? `default`;

// Default DELETES the key: the schema has no fourth value, and the floors key on the key being absent.
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
