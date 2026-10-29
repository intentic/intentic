import { mapPool } from "@intentic/base/async";

// Bounded repository scans, with results kept in input order.
export const mapBounded = async <T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = [];
    await mapPool([...items.entries()], limit, async ([index, item]) => {
        results[index] = await run(item);
    });
    return results;
};

