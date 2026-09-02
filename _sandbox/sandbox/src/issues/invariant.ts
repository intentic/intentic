import type { InvariantCheck } from "../invariants/invariants.js";
import type { IssuesStore } from "./issues-store.js";

/* EVERY FILE IN THE INBOX READS BACK AS AN ISSUE, or a crash has stopped being counted.
 *
 * issues-store.ts says it in its own words: nothing but this daemon writes an issue, so a file in there that
 * will not parse is a bug in this daemon or a half-written volume, "which is why `invalid` still exists: to
 * make that visible rather than to tolerate it". Visible to whom, though. `list` answers with the names it
 * refused and a route hands them to a page, and nothing reads them while no page is open. Meanwhile the group
 * behind an unreadable file goes on happening: its reports arrive, `record` reads the file as absent, writes
 * a fresh group over it or beside it, and the count that decides whether anybody is woken starts again from
 * one. The inbox's whole promise, that a thousand copies of one crash are one row whose count goes up, is the
 * thing that fails. */

export interface IssuesInboxDeps {
    readonly issues: IssuesStore;
}

export const owner = "issues";

export const checks = ({ issues }: IssuesInboxDeps): readonly InvariantCheck[] => [
    {
        name: "issue-files-read-back",
        // Boot too: writes are atomic (store/json-dir.ts), so a file that will not parse is not a write the
        // previous life was in the middle of. It is one this daemon wrote whole, and the sooner the better.
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
