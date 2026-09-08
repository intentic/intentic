import type { AssistantSource } from "@intentic/api-contract";

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

export const SOURCE_GUIDES: Record<AssistantSource, SourceGuide> = {
    hermes: {
        label: `Hermes`,
        folder: `.hermes`,
        command: `tar czf ~/hermes-setup.tar.gz -C ~ .hermes && echo "Ready: ~/hermes-setup.tar.gz"`,
        lands: `It prints "Ready" and leaves hermes-setup.tar.gz in your home folder. No "Ready" line means it did not work, read the error above it.`,
    },
    openclaw: {
        label: `OpenClaw`,
        folder: `.openclaw`,
        command: `openclaw backup create --output ~ --verify`,
        lands: `It prints the name of the file it made, in your home folder.`,
        fallbackCommand: `tar czf ~/openclaw-setup.tar.gz -C ~ .openclaw && echo "Ready: ~/openclaw-setup.tar.gz"`,
        fallbackNote: `Older versions have no backup command. This packs the folder directly instead.`,
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
        title: `It runs on a server, not on this device`,
        body: `Usual case. Run the command over SSH on the server, then bring the file down to the device you are reading this on, replace the parts in capitals with yours.`,
        command: `scp YOU@YOUR-SERVER:~/${guide.folder === `.hermes` ? `hermes` : `openclaw`}-setup.tar.gz ~/Downloads/`,
    },
    {
        title: `I can't find the folder`,
        body: `This prints where it is, including the case where it was moved somewhere custom. Pack whatever folder it names, any folder name works, since we find the setup by its settings file rather than by its name.`,
        command: `ls -d ~/${guide.folder} 2>/dev/null; echo "$HERMES_HOME $OPENCLAW_STATE_DIR"`,
    },
    {
        title: `It runs in a container`,
        body: `Then the folder lives inside the container, not on the machine. Copy it out first, then pack the copy, replace NAME with your container's name.`,
        command: `docker cp NAME:/root/${guide.folder} ./setup && tar czf ~/setup.tar.gz -C . setup`,
    },
];
