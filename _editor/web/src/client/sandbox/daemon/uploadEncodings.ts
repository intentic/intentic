import { sandboxRef } from "@intentic/extension-api";

// The codings the active daemon decodes an upload from, off its /events hello's `uploadEncodings`. Empty until a hello
// names them, which is also every daemon from before the field and the desktop app's folder sidecar: those write the
// bytes that arrive as they are, so nothing is ever encoded for them. Sandbox-scoped like the route list beside it.
const advertised = sandboxRef<readonly string[]>(() => []);

// Called on every hello frame.
export const setUploadEncodings = (encodings: readonly string[] | undefined): void => {
    advertised.value = encodings ?? [];
};

// Whether an upload to the active daemon may be sent gzipped (`Content-Encoding: gzip`).
export const daemonDecodesGzip = (): boolean => advertised.value.includes(`gzip`);
