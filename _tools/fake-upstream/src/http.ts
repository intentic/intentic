import type { IncomingMessage, ServerResponse } from "node:http";

/* THE REQUEST-BODY READ AND THE JSON REPLY, OWNED HERE RATHER THAN IMPORTED, and that is the whole point of
 * this file.
 *
 * `@intentic/testing/http-fake` holds these same two functions for every OTHER fake in the repo, and importing
 * them from there is the obvious move. It is also the one this package cannot make: this fake is the only one
 * that SHIPS AS AN IMAGE, and its Dockerfile is the stock node base with `package.json` and `src` copied in —
 * no install, no node_modules, no build. A workspace import in here type-checks, passes its own suite, and
 * resolves fine from the checkout; it then dies inside the container on `ERR_MODULE_NOT_FOUND` the moment the
 * onboarding journey stands the world up.
 *
 * That is not hypothetical. It is how the nightly `onboarding` job failed for a night: the stand-in exited
 * instantly, and because the crash went to stderr the harness reported "the stand-in model exited before it
 * answered" with an empty log under it. Twenty lines duplicated is the price of the image staying buildable by
 * `docker build .`, and it is the cheaper side of that trade.
 *
 * SO: nothing under this package's `src/` may import anything outside this package. Its tests and its
 * vitest config are free to — they never enter the image.
 */

// The whole request body as text. Fakes answer small, scripted payloads, so buffering is the right shape:
// a fake that streamed its input would be testing node's stream plumbing rather than the caller's request.
export const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
};

/* A JSON reply with an explicit `content-length`. The length matters: a client that reads to EOF cannot tell
 * a complete short answer from a connection that died mid-body, and a fake whose refusals are indistinguishable
 * from a dropped socket is a fake that makes retry logic untestable. */
export const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
};
