import type { CapabilitySummary } from "@intentic/api-contract";
import type { CapabilityKind } from "@intentic/sandbox-contract";
import { updateBrief } from "@intentic/sandbox-contract/chores";
import { auditBrief } from "../../sandbox/extensions/extensionBrief";
import { type FormValues, isCommitSha } from "./form";

// Having an agent read an extension before its install is approved: offered once the form pins a commit, and read as
// a diff when an edit moves an install to another commit. Pure over the form's answers.

// True once there's a commit sha to read.
export const auditOffered = (kind: CapabilityKind | undefined, values: Readonly<FormValues>): boolean =>
    kind === `extension` && isCommitSha(values[`ref`]) && (values[`url`] ?? ``) !== ``;

// The commit an edit replaces, so the read can be of what changed instead of the whole tree again; undefined with no
// read offered, while adding, or while the pin stays where it was.
export const replacedPin = (
    kind: CapabilityKind | undefined,
    editing: CapabilitySummary | undefined,
    values: Readonly<FormValues>,
): string | undefined => {
    if (!auditOffered(kind, values) || editing === undefined) {
        return undefined;
    }
    const installed = editing.config[`ref`];
    if (typeof installed !== `string` || !isCommitSha(installed) || installed === values[`ref`]) {
        return undefined;
    }
    return installed;
};

// The agent's brief: the pinned code read whole, or the change from the commit being replaced.
export const auditPrompt = (name: string, values: Readonly<FormValues>, from: string | undefined): string => {
    const typed = name.trim();
    const shared = { label: typed === `` ? String(values[`url`]) : typed, url: String(values[`url`]), path: String(values[`path`] ?? ``) };
    if (from === undefined) {
        return auditBrief({ ...shared, ref: String(values[`ref`]) });
    }
    return updateBrief({ ...shared, fromRef: from, toRef: String(values[`ref`]) });
};
