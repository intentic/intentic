import type { AssistantSource } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// Per-tool instructions for migrating setup to another device, as data (testable, keeps the card about layout).
// One tool, one command, its output location named, and the three common failure modes each answered in place.
// OpenClaw uses its own backup command since it can't get paths wrong; Hermes has none, so it's a manual archive.

export interface SourceGuide {
    readonly label: string;
    // The folder to look for, in the sentence the reader is scanning for.
    readonly folder: string;
    readonly command: string;
    // What happens after the command, in the words the reader will see on their own screen.
    readonly lands: string;
    // Shown behind "the command isn't available", the way that always works.
    readonly fallbackCommand?: string;
    readonly fallbackNote?: string;
}

// The prose is read through getters, so it follows a language switch; the commands stay as written.
export const SOURCE_GUIDES: Record<AssistantSource, SourceGuide> = {
    hermes: {
        label: `Hermes`,
        folder: `.hermes`,
        command: `tar czf ~/hermes-setup.tar.gz -C ~ .hermes && echo "Ready: ~/hermes-setup.tar.gz"`,
        get lands(): string {
            return t(`sandbox.assistantGuide.hermesLands`);
        },
    },
    openclaw: {
        label: `OpenClaw`,
        folder: `.openclaw`,
        command: `openclaw backup create --output ~ --verify`,
        get lands(): string {
            return t(`sandbox.assistantGuide.openclawLands`);
        },
        fallbackCommand: `tar czf ~/openclaw-setup.tar.gz -C ~ .openclaw && echo "Ready: ~/openclaw-setup.tar.gz"`,
        get fallbackNote(): string {
            return t(`sandbox.assistantGuide.openclawFallbackNote`);
        },
    },
};

export interface HelpTopic {
    readonly title: string;
    readonly body: string;
    readonly command?: string;
}

// The three ways this can go wrong (server, missing folder, container), each answered where the reader hits it;
// folded shut so the two-step case never has to read past them.
export const helpTopics = (guide: SourceGuide): HelpTopic[] => [
    {
        title: t(`sandbox.assistantGuide.runsOnServerNot`),
        body: t(`sandbox.assistantGuide.usualCaseRunCommand`),
        command: `scp YOU@YOUR-SERVER:~/${guide.folder === `.hermes` ? `hermes` : `openclaw`}-setup.tar.gz ~/Downloads/`,
    },
    {
        title: t(`sandbox.assistantGuide.iCantFindFolder`),
        body: t(`sandbox.assistantGuide.printsWhereIncludingCase`),
        command: `ls -d ~/${guide.folder} 2>/dev/null; echo "$HERMES_HOME $OPENCLAW_STATE_DIR"`,
    },
    {
        title: t(`sandbox.assistantGuide.runsInContainer`),
        body: t(`sandbox.assistantGuide.folderLivesInsideContainer`),
        command: `docker cp NAME:/root/${guide.folder} ./setup && tar czf ~/setup.tar.gz -C . setup`,
    },
];
