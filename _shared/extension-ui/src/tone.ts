// The kit's tone vocabulary, reachable without the component barrel: `index.ts` pulls in every .vue component, which
// breaks an extension's node-environment tests, and a status table in a plain module (a pipeline's stage colours) is
// exactly what such a test reads. A source-level door for in-repo extensions and their tests; a git-installed bundle
// resolves through the import map instead, which carries the same names.
export {
    type DiffMark,
    diffMark,
    type Signal,
    type TintWeight,
    type Tone,
    toneDot,
    toneFill,
    toneHover,
    toneInk,
    tonePlate,
    toneRim,
    toneTint,
    toneWash,
} from "@intentic/ui/tone";
