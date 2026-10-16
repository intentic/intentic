import { globRegExp } from "@intentic/sandbox-contract/policy/search-globs";

// A scope filter's glob as a RegExp over forward-slash relative paths. The matching itself is the contract's, Bun.Glob's
// reading of every construct, so `iq` and the search box admit the same files; what stays here is how `iq` reads a
// pattern before matching, as ripgrep's -g does: a glob without a slash matches a name at any depth, a leading `./` is
// the root, and a trailing `/` means the directory and everything under it.
export const globToRegExp = (glob: string): RegExp => {
    const rooted = glob.includes("/") ? glob.replace(/^\.\//, "") : `**/${glob}`;
    return globRegExp(rooted.endsWith("/") ? `${rooted}**` : rooted);
};
