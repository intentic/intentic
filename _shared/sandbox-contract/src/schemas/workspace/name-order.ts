// The one order a folder's entries are listed in, by the daemon's walk, the desktop app's folder server, the browser's
// provisional rows and the home alike: a folder that read `file1, file10, file2` in the tree and `file1, file2, file10`
// in the home was two orders for one folder. Natural, as every desktop file manager sorts (`shot-2` before `shot-10`),
// and case-folded, so `README.md` sits among the r's.
//
// A fixed locale, not the reader's: the daemon sorts with whatever locale its process happens to start under, and the
// browser re-sorts a listing when a provisional row joins it, so two different collations would shuffle the rows the
// moment a paste landed. English collation still files an accented letter beside its base letter.
const collator = new Intl.Collator(`en`, { numeric: true, sensitivity: `base` });

/** Natural, case-insensitive name order; names that collate alike fall back to code-point order, so it is total. */
export const compareNames = (left: string, right: string): number => collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);

/** Folders before files, then natural name order: how every listing of a folder is laid out. */
export const compareListed = (
    left: { readonly name: string; readonly dir: boolean },
    right: { readonly name: string; readonly dir: boolean },
): number => (left.dir === right.dir ? compareNames(left.name, right.name) : left.dir ? -1 : 1);
