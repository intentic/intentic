// Shared CI-provider helpers used by every git-forge CI provider: the placeholder Dockerfile seeded into a fresh
// repo, and the whitespace-normalizer the diff uses.

// The CI secret names, a contract in two directions: each is written into the repo's secret store and referenced
// by name inside the workflow YAML the same provider commits.
export const SECRET_KOMODO = "KOMODO_PASSWORD";

// A minimal, immediately-buildable starter committed only when the repo has no Dockerfile, matching the
// deterministic PORT the deployment injects.
export const starterDockerfile = (): string =>
    [
        "# intentic starter Dockerfile: replace with your app's real build.",
        "FROM busybox:1.38.0@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e",
        "RUN mkdir -p /www && printf '%s' 'intentic: replace this Dockerfile with your app' > /www/index.html",
        "ENV PORT=8080",
        "EXPOSE 8080",
        'CMD ["sh","-c","httpd -f -v -p $PORT -h /www"]',
        "",
    ].join("\n");

// Strip trailing whitespace per line + trim, so a diff against desired content ignores incidental drift.
export const normalize = (yaml: string): string =>
    yaml
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .join("\n")
        .trim();
