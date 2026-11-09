// How a setting of the Overview's list is drawn, the look the secrets and automations lists already wear: a value that is
// also the place to change it has no box at rest and a hover wash under the pointer, so the list reads as text and
// still answers the hand. Pulled out by its own padding, so its words line up with the rows around it, not the wash.
export const EDITABLE_VALUE = `group/value -mx-2 flex min-w-0 cursor-pointer flex-col items-start rounded-md px-2 py-1 text-left transition-colors hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`;

// The same value where nothing here can change it: the same box, so a column of mixed rows keeps one edge.
export const FIXED_VALUE = `flex min-w-0 flex-col items-start py-1`;
