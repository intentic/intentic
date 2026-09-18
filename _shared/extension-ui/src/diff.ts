// The kit's diff machinery, reachable without the component barrel (see format.ts for why): edit scripts over any
// items, word-level segments between two texts, and the pairing of removals with additions. What a viewer that draws
// two versions of a file as one computes its marks with, so its redline agrees with the app's own prose diff.
export { diffSequence, pairEdits, similarity, wordDiff, type Edit, type Op, type Segment, type SegmentKind } from "@intentic/ui/diff";
