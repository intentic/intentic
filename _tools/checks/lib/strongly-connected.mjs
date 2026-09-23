// Tarjan's algorithm, iterative: a recursive version blows the stack on a large import graph. Returns every component,
// singletons included, each as the nodes it holds; `edgesOf(node)` answers with an array.
export const stronglyConnected = (nodes, edgesOf) => {
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const components = [];
    let counter = 0;

    // Discovers a node: assigns it an index and pushes a work frame.
    const discover = (node, work) => {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
        work.push({ node, edges: edgesOf(node), position: 0 });
    };

    // Unwinding one completed root: everything above it on the stack is its component.
    const popComponent = (node) => {
        const component = [];
        let popped;
        do {
            popped = stack.pop();
            onStack.delete(popped);
            component.push(popped);
        } while (popped !== node);
        return component;
    };

    const step = (frame, work) => {
        if (frame.position < frame.edges.length) {
            const next = frame.edges.at(frame.position);
            frame.position += 1;
            if (!index.has(next)) {
                discover(next, work);
            } else if (onStack.has(next)) {
                low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
            }
            return;
        }

        work.pop();
        const parent = work.at(-1);
        if (parent) {
            low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));
        }
        if (low.get(frame.node) === index.get(frame.node)) {
            components.push(popComponent(frame.node));
        }
    };

    for (const root of nodes) {
        if (index.has(root)) {
            continue;
        }
        const work = [];
        discover(root, work);
        while (work.length > 0) {
            step(work.at(-1), work);
        }
    }
    return components;
};
