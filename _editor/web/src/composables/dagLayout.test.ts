import { describe, expect, it } from "vitest";
import { type DagEdge, type DagNode, layoutSignature } from "@intentic/ui/dag";

/* DagGraph refits its viewport when this signature changes. It lives here rather than in @intentic/ui because
 * the design system ships no test runner (same reason as figures.test.ts).
 *
 * The bug it exists for: the refit watcher used to key on the node COUNT. A count is not an identity, so two
 * different graphs of the same size looked identical to the watcher, and a caller that renders one DagGraph per
 * document page (keyed by position, so Vue patches rather than remounts) carried the previous page's pan and zoom
 * onto the next graph. Worst when a 2-node graph came first: its fit had clamped to maxZoom, so the next page
 * rendered at 2×. Every case below is one way two graphs can differ without differing in length. */

const node = (id: string): DagNode<undefined> => ({ id, data: undefined });
const edge = (from: string, to: string): DagEdge => ({ from, to });
const options = { direction: `LR` as const, nodeWidth: 208, nodeHeight: 64 };
const sig = (nodes: readonly DagNode<undefined>[], edges: readonly DagEdge[] = [], overrides = {}) =>
    layoutSignature(nodes as readonly DagNode<never>[], edges, { ...options, ...overrides });

describe(`layoutSignature`, () => {
    it(`is stable for the same graph`, () => {
        expect(sig([node(`a`), node(`b`)], [edge(`a`, `b`)])).toBe(sig([node(`a`), node(`b`)], [edge(`a`, `b`)]));
    });

    it(`distinguishes two graphs with the SAME node count`, () => {
        // The whole bug in one assertion: `length` cannot tell these apart, so no refit happened between them.
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`c`), node(`d`)]));
    });

    it(`distinguishes the same nodes wired differently`, () => {
        // Same nodes, same count, but dagre puts them in different places, so the fit must change.
        expect(sig([node(`a`), node(`b`)], [edge(`a`, `b`)])).not.toBe(sig([node(`a`), node(`b`)], [edge(`b`, `a`)]));
    });

    it(`distinguishes a graph with no edges from a connected one`, () => {
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`a`), node(`b`)], [edge(`a`, `b`)]));
    });

    it(`notices node order, which dagre lays out from`, () => {
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`b`), node(`a`)]));
    });

    it(`notices direction and the node box`, () => {
        expect(sig([node(`a`)])).not.toBe(sig([node(`a`)], [], { direction: `TB` }));
        expect(sig([node(`a`)])).not.toBe(sig([node(`a`)], [], { nodeHeight: 56 }));
        expect(sig([node(`a`)])).not.toBe(sig([node(`a`)], [], { nodeWidth: 240 }));
    });

    it(`still changes when the count changes, which is what it replaced`, () => {
        expect(sig([node(`a`)])).not.toBe(sig([node(`a`), node(`b`)]));
    });

    /* Labels are deliberately NOT in it. Re-rendering the same shape with new text must not discard a pan the
     * user chose: the viewport is theirs once they touch it, and only a different graph may take it back. */
    it(`ignores everything that cannot move a node`, () => {
        const plain: DagNode<undefined> = { id: `a`, data: undefined };
        const dressed: DagNode<undefined> = { id: `a`, data: undefined, tooltip: `hello`, dimmed: true };
        expect(sig([plain])).toBe(sig([dressed]));
    });
});
