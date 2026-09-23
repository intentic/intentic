import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import { type RemoteRef, type RemoteRefs, VAULTED } from "@intentic/sandbox-contract";
import type { PickerGroup } from "@intentic/ui";
import { type FormValues, isCommitSha, type StoredSecrets } from "./form";
import { t } from "@intentic/ui/i18n";

// The one field the picker stands in for: an extension's `ref`, the only answer on this form that must be a commit and
// can never be a name. Everything else stays a plain box.
export const picksVersion = (entry: CapabilityCatalogEntry, field: CapabilityField): boolean => entry.kind === `extension` && field.key === `ref`;

// What the version read authorizes with: the token typed here, or the marker for one this edit is keeping, which the
// daemon resolves against the connection; without it a private repo's install could never list its versions.
export const versionReadToken = (values: Readonly<FormValues>, stored: StoredSecrets): string => {
    const typed = (values[`token`] ?? ``).trim();
    return typed === `` && stored.has(`token`) ? VAULTED : typed;
};

// The version picker's model: what a repository offers, ordered the way someone looks for it, and which entry to land
// on when the answer arrives. Pure over the daemon's reply; the component only draws what these return.

/** The picker row that reveals the raw box, for a commit that is neither a branch nor a tag. */
export const MANUAL_KEY = `manual`;

// Keyed by kind and name rather than by sha: a branch and a tag sitting on the same commit are two different answers,
// and one key must not select both rows.
export const refKey = (ref: RemoteRef): string => `${ref.kind}:${ref.name}`;

export const shortSha = (sha: string): string => sha.slice(0, 7);

interface Version {
    readonly parts: readonly number[];
    /** A `-rc.1` suffix; a release sorts ahead of its own prereleases. */
    readonly pre: string | undefined;
}

const SEMVER = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+](.+))?$/;

const versionOf = (name: string): Version | undefined => {
    const match = SEMVER.exec(name);
    if (match === null) {
        return undefined;
    }
    return { parts: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)], pre: match[4] };
};

// Highest first, and a release ahead of its own prereleases: 1.2.0 leads 1.2.0-rc.2 leads 1.2.0-rc.1.
const compareVersions = (a: Version, b: Version): number => {
    for (let index = 0; index < 3; index += 1) {
        const difference = (b.parts[index] ?? 0) - (a.parts[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    if (a.pre === undefined || b.pre === undefined) {
        return a.pre === b.pre ? 0 : a.pre === undefined ? -1 : 1;
    }
    return b.pre.localeCompare(a.pre);
};

// Newest first. Version-shaped tags lead, ordered as versions rather than as text (so v10 beats v9); anything else
// follows in reverse name order, which puts a dated tag newest-first too.
const compareTags = (left: RemoteRef, right: RemoteRef): number => {
    const a = versionOf(left.name);
    const b = versionOf(right.name);
    if (a !== undefined && b !== undefined) {
        return compareVersions(a, b);
    }
    if (a !== undefined || b !== undefined) {
        return a !== undefined ? -1 : 1;
    }
    return right.name.localeCompare(left.name);
};

// The default branch leads its group: it is the one a reader means by "the repository".
const compareBranches =
    (defaultBranch: string | undefined) =>
    (left: RemoteRef, right: RemoteRef): number => {
        if (left.name === defaultBranch || right.name === defaultBranch) {
            return left.name === defaultBranch ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
    };

const branchesOf = (refs: RemoteRefs): readonly RemoteRef[] =>
    refs.refs.filter((ref) => ref.kind === `branch`).toSorted(compareBranches(refs.defaultBranch));

const tagsOf = (refs: RemoteRefs): readonly RemoteRef[] => refs.refs.filter((ref) => ref.kind === `tag`).toSorted(compareTags);

// Releases lead when a repository publishes any: a tag is a deliberate version, a branch is wherever work happens to
// have reached. The manual row is last and always present, so a commit off every branch is still installable.
export const refGroups = (refs: RemoteRefs): readonly PickerGroup[] => {
    const tags = tagsOf(refs);
    const branches = branchesOf(refs);
    return [
        ...(tags.length === 0
            ? []
            : [
                  {
                      label: t(`capabilities.refs.releases`),
                      options: tags.map((tag) => ({ value: refKey(tag), label: tag.name, description: shortSha(tag.sha), icon: `box` as const })),
                  },
              ]),
        ...(branches.length === 0
            ? []
            : [
                  {
                      label: t(`capabilities.refs.branches`),
                      options: branches.map((branch) => ({
                          value: refKey(branch),
                          label: branch.name,
                          description: branch.name === refs.defaultBranch ? `default · ${shortSha(branch.sha)}` : shortSha(branch.sha),
                          icon: `fork` as const,
                      })),
                  },
              ]),
        { options: [{ value: MANUAL_KEY, label: t(`capabilities.refs.commitSha`), icon: `code` as const }] },
    ];
};

/** Either a version from the list, or the raw box for a commit the list doesn't name. */
export type RefChoice = { readonly kind: `ref`; readonly ref: RemoteRef } | { readonly kind: `manual` };

// What the picker lands on once an answer arrives, given whatever the box already holds. Undefined means the
// repository advertises nothing to pick from, which leaves the raw box exactly as the reader left it.
export const initialChoice = (refs: RemoteRefs, pinned: string | undefined): RefChoice | undefined => {
    const holding = refs.refs.find((ref) => ref.sha === pinned);
    if (holding !== undefined) {
        return { kind: `ref`, ref: holding };
    }
    // A commit already in the box was put there deliberately — an edit's live install, a registry pick — so resolving
    // the repository must never quietly move it to something newer.
    if (isCommitSha(pinned)) {
        return { kind: `manual` };
    }
    const preferred = branchesOf(refs)[0] ?? tagsOf(refs)[0];
    return preferred === undefined ? undefined : { kind: `ref`, ref: preferred };
};

export const refFor = (refs: RemoteRefs, key: string): RemoteRef | undefined => refs.refs.find((ref) => refKey(ref) === key);

// The line under the picker. Says the commit, because that is what is stored and what an audit reads, and says the pin
// holds, because the whole point of resolving a branch here is that the install stops following it.
export const refSummary = (ref: RemoteRef): string =>
    ref.kind === `tag`
        ? `${ref.name} is commit ${shortSha(ref.sha)}. That commit is what gets installed, so a re-tag can't move it.`
        : `${ref.name} is at commit ${shortSha(ref.sha)}. That commit is what gets installed, so the branch can't move under it.`;
