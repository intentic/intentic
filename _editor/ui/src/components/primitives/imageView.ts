// What a view is showing, shared between panes that must agree (a binary diff). `fit` is its own state,
// not a computed scale, since two differently sized images fit at different percentages.
export type ImageViewState = { readonly fit: true } | { readonly fit: false; readonly scale: number; readonly x: number; readonly y: number };
