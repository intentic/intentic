import type { CommandClass } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// COMMAND_RULE_CATALOG says what each command class does, and what narrows each of its patterns, in English: the safety
// judge reads the same words. These are the Safety page's words for them; ruleWords.test.ts holds the English copy
// equal to the contract's. A qualifier with no entry (one the contract gains later) is shown as the contract spells it.

const CLASS_LABELS: Readonly<Record<CommandClass, () => string>> = {
    "git.destructive": () => t(`sandbox.safetyRules.classes.gitDestructive`),
    "git.branch-switch": () => t(`sandbox.safetyRules.classes.gitBranchSwitch`),
    "files.destructive": () => t(`sandbox.safetyRules.classes.filesDestructive`),
    "system.destructive": () => t(`sandbox.safetyRules.classes.systemDestructive`),
    "container.state": () => t(`sandbox.safetyRules.classes.containerState`),
    "secrets.access": () => t(`sandbox.safetyRules.classes.secretsAccess`),
    "package.publish": () => t(`sandbox.safetyRules.classes.packagePublish`),
    "network.outbound": () => t(`sandbox.safetyRules.classes.networkOutbound`),
};

const QUALIFIERS: ReadonlyMap<string, () => string> = new Map([
    [`a destination built at run time counts, since its host can't be read beforehand`, () => t(`sandbox.safetyRules.qualifiers.runtimeDestination`)],
    [`a stored secret, used in the command itself`, () => t(`sandbox.safetyRules.qualifiers.storedSecret`)],
    [`also -exec rm and -execdir rm`, () => t(`sandbox.safetyRules.qualifiers.alsoExecRm`)],
    [`also -f and --force-with-lease`, () => t(`sandbox.safetyRules.qualifiers.alsoForceWithLease`)],
    [`also find / -delete; only when the target is a root, listed below`, () => t(`sandbox.safetyRules.qualifiers.alsoFindDelete`)],
    [`also ncat, netcat, telnet, ftp and ssh`, () => t(`sandbox.safetyRules.qualifiers.alsoNetcat`)],
    [`also pnpm, yarn, bun`, () => t(`sandbox.safetyRules.qualifiers.alsoPnpm`)],
    [`also remove, prune, and podman for any of these`, () => t(`sandbox.safetyRules.qualifiers.alsoPrune`)],
    [`also rmSync, rmdir, rmdirSync`, () => t(`sandbox.safetyRules.qualifiers.alsoRmSync`)],
    [`also sftp and rsync with a remote side, and socat TCP:host:port`, () => t(`sandbox.safetyRules.qualifiers.alsoSftp`)],
    [`also wget; a literal loopback address does not count, even with a variable port`, () => t(`sandbox.safetyRules.qualifiers.alsoWget`)],
    [`any flags: a checkout's link to its history`, () => t(`sandbox.safetyRules.qualifiers.anyFlags`)],
    [`any interpreter's inline code that opens a connection`, () => t(`sandbox.safetyRules.qualifiers.inlineCode`)],
    [`in a script`, () => t(`sandbox.safetyRules.qualifiers.inScript`)],
    [
        `not \`git checkout -- <path>\` or \`git checkout .\`, which restore files and move nothing`,
        () => t(`sandbox.safetyRules.qualifiers.notRestore`),
    ],
    [`only in the current folder, which may already be a checkout`, () => t(`sandbox.safetyRules.qualifiers.currentFolder`)],
]);

/** What a command of this class would do, in the reader's language. */
export const commandClassWords = (commandClass: CommandClass): string => CLASS_LABELS[commandClass]();

/** What narrows a pattern, in the reader's language. */
export const qualifierWords = (qualifier: string): string => QUALIFIERS.get(qualifier)?.() ?? qualifier;
