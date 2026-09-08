import type { InvariantCheck } from "../invariants/invariants.js";
import type { IssuesStore } from "./issues-store.js";

// Every file in the inbox must read back as an issue, or a crash silently stops being counted. This daemon is the only
// writer, so an unparseable file is a daemon bug or a damaged volume; record() then reads it as absent and restarts the
// count from one, breaking the inbox's promise that a thousand copies of one crash stay one row.

export interface IssuesInboxDeps {
    readonly issues: IssuesStore;
}

export const owner = "issues";

export const checks = ({ issues }: IssuesInboxDeps): readonly InvariantCheck[] => [
    {
        name: "issue-files-read-back",
        // Boot too: writes are atomic, so a bad file was written whole, not caught mid-write; sooner found is better.
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            const { invalid } = await issues.list();
            if (invalid.length > 0) {
                fail(
                    `${invalid.length} file(s) in the issues inbox will not read back as issues (${invalid.join(", ")}): this daemon is their only writer, so each is a daemon bug or a damaged volume, and the crash behind it is no longer being counted`,
                );
            }
        },
    },
];
