// Kahn topological sort with declaration-order tiebreak (deterministic, human-readable bootstrap order).

export const topoSort = (ids: readonly string[], dependsOn: ReadonlyMap<string, readonly string[]>): string[] => {
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of ids) {
        inDegree.set(id, 0);
        dependents.set(id, []);
    }
    for (const id of ids) {
        for (const dep of dependsOn.get(id) ?? []) {
            inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
            dependents.get(dep)?.push(id);
        }
    }

    const queue = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
    const order: string[] = [];
    while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined) {
            break;
        }
        order.push(id);
        for (const dependent of dependents.get(id) ?? []) {
            const remaining = (inDegree.get(dependent) ?? 0) - 1;
            inDegree.set(dependent, remaining);
            if (remaining === 0) {
                queue.push(dependent);
            }
        }
    }

    if (order.length !== ids.length) {
        const cycle = ids.filter((id) => !order.includes(id));
        throw new Error(`dependency cycle: ${cycle.join(" -> ")}`);
    }
    return order;
};
