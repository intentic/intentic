// How an open secret's facts are drawn, one look for every row of them: a value that is also the place to change it has
// no box at rest and the row's own hover wash under the pointer, so the column reads as text and still answers the hand.
// Pulled out by its own padding, so its words line up with the label beside them rather than with the wash.
export const EDITABLE_VALUE = `-mx-2 flex min-w-0 cursor-pointer flex-col items-start rounded-md px-2 py-1 text-left transition-colors hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`;

// The same value where nothing here can change it: the same box, so a column of mixed rows keeps one edge.
export const FIXED_VALUE = `flex min-w-0 flex-col items-start py-1`;

// The value itself, and the quieter line under it that says what it means.
export const VALUE_TEXT = `text-sm text-content`;
export const VALUE_NOTE = `text-xs text-subtle`;
