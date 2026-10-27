// Disposers run newest first, every one of them even when an earlier one throws, and their failures are reported together.
export const cleanupStack = (what: string) => {
    const disposers: (() => Promise<void>)[] = [];
    return {
        add: (dispose: () => Promise<void>): void => {
            disposers.unshift(dispose);
        },
        close: async (): Promise<void> => {
            const failures: unknown[] = [];
            for (const dispose of disposers.splice(0)) {
                try {
                    await dispose();
                } catch (error) {
                    failures.push(error);
                }
            }
            if (failures.length > 0) {
                throw new AggregateError(failures, `${what} cleanup failed`);
            }
        },
    };
};

export type CleanupStack = ReturnType<typeof cleanupStack>;
