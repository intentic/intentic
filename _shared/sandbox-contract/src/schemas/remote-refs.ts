// What a git remote advertises right now: the versions an install form can pin to without anyone reading a sha off a
// web page. Answered from `git ls-remote`, so nothing is cloned and nothing is written.
import { z } from "zod";

// POST so a private repository's token never rides a URL or an access log, the same reasoning as the marketplace read.
export const RemoteRefsRequestSchema = z.object({
    url: z.url().describe("The repository to ask. http(s) only: an ssh remote would stop on a host-key prompt nobody can answer."),
    token: z
        .string()
        .min(1)
        .optional()
        .describe(
            "A credential for a private one. Sent as a body rather than in the address, so it never lands in a log. A form editing a live connection has never been shown its token: it sends the VAULTED marker here and names the connection in `keeping`, so a private repository still answers without anyone retyping a key.",
        ),
    keeping: z
        .string()
        .min(1)
        .optional()
        .describe("Which connection a VAULTED token belongs to. Ignored when a real token is sent."),
});

export const RemoteRefSchema = z.object({
    name: z.string().describe("The branch or tag as a person names it: `main`, `v1.4.0`."),
    kind: z.enum(["branch", "tag"]),
    sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .describe("The commit it points at. An annotated tag is peeled here, so this is always a commit, never a tag object."),
});
export type RemoteRef = z.infer<typeof RemoteRefSchema>;

export const RemoteRefsSchema = z.object({
    defaultBranch: z
        .string()
        .optional()
        .describe("The branch the remote advertises as HEAD, the one to offer first. Absent when the remote advertises no symref."),
    refs: z.array(RemoteRefSchema).describe("Every branch the remote advertises, then every tag. Which to offer first is the reader's question, not this one's."),
});
export type RemoteRefs = z.infer<typeof RemoteRefsSchema>;
