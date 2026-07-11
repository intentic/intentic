// How the workspace file tree presents its icons — orthogonal to the icon set (which glyph library).
// A "setup" bundles size + colour + emphasis, chosen in Settings (useExplorerStyle):
//   minimal  — monochrome, compact, calm.
//   colorful — a distinct theme-aware hue per file category, accent-tinted folders.
//   vivid    — larger glyphs, same category colours, folders rendered as filled accent chips.
export type ExplorerStyle = "minimal" | "colorful" | "vivid";

export const explorerStyles: ExplorerStyle[] = ["minimal", "colorful", "vivid"];
