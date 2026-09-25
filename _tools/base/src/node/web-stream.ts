import type { ReadableStream as NodeReadableStream } from "node:stream/web";

// The global ReadableStream (bun-types' in a test program) and node:stream/web's name one runtime object that the
// checker sees no overlap between; a stream crossing that line is renamed here and nowhere else.
export const nodeStream = <T>(stream: ReadableStream<T>): NodeReadableStream<T> => stream as unknown as NodeReadableStream<T>;

export const webStream = <T>(stream: NodeReadableStream<T>): ReadableStream<T> => stream as unknown as ReadableStream<T>;
