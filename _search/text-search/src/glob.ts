import { globRegExp } from "@intentic/sandbox-contract/policy/search-globs";

// A scope filter's glob as a RegExp over forward-slash relative paths. The matching itself is the contract's, Bun.Glob's
// reading of every construct; what stays here is how a search box's pattern is read before matching, as ripgrep's -g
// reads it: a glob without a slash matches a name at any depth, a leading `./` is the root, and a trailing `/` means the
// directory and everything under it.
export const globToRegExp = (glob: string): RegExp => {
    const rooted = glob.includes("/") ? glob.replace(/^\.\//, "") : `**/${glob}`;
    return globRegExp(rooted.endsWith("/") ? `${rooted}**` : rooted);
};
