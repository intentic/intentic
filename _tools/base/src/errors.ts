/* The thrown thing's message, for the places that need a STRING rather than something to show a person: a log line, an IPC reply's `error` field. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
