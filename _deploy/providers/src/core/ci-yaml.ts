// Shared CI-provider helpers used by every git-forge CI provider (forgejo/ci.ts, github/gh-ci.ts,
// gitlab/gl-ci.ts): the placeholder Dockerfile seeded into a fresh repo, and the whitespace-normalizer the
// diff uses so trailing-space drift in a committed CI file doesn't read as a change.

// A minimal, immediately-buildable starter committed ONLY when the repo has no Dockerfile, so a fresh repo is
// live with a placeholder until the author pushes their real Dockerfile (busybox httpd on $PORT, matching the
// deterministic PORT the deployment injects).
export const starterDockerfile = (): string =>
    [
        "# intentic starter Dockerfile: replace with your app's real build.",
        "FROM busybox:1.38.0@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616",
        "RUN mkdir -p /www && printf '%s' 'intentic: replace this Dockerfile with your app' > /www/index.html",
        "ENV PORT=8080",
        "EXPOSE 8080",
        'CMD ["sh","-c","httpd -f -v -p $PORT -h /www"]',
        "",
    ].join("\n");

// Strip trailing whitespace per line + trim, so a diff of a committed CI file against the desired content
// ignores incidental whitespace drift.
export const normalize = (yaml: string): string =>
    yaml
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .join("\n")
        .trim();
