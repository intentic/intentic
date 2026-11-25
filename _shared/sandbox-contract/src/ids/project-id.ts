// One spelling for "a project" across account-level report routing: the platform keys claims by it, the sending daemon
// resolves by it, the receiving daemon checks a pass against it. A project is a repository, named the way its remote
// names it, so `git@github.com:Acme/App.git`, `https://github.com/acme/app` and `github.com/acme/app/` are one project:
// `github.com/acme/app`. Host and path are lowercased; the hosts people use are case-insensitive about owners and repos.

// host + at least one path segment, each a conservative charset; nothing that could be a URL with a query or a port.
const PROJECT_ID = /^[a-z0-9.-]+\.[a-z]{2,}(\/[a-z0-9._~-]+)+$/;

export const PROJECT_ID_MAX = 200;

// The normalized id, or undefined when the text does not name a repository.
export const normalizeProjectId = (raw: string): string | undefined => {
    let text = raw.trim();
    if (text === "") {
        return undefined;
    }
    // scp-like ssh: user@host:path
    const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(text);
    if (scp !== null) {
        text = `${scp[1]}/${scp[2]}`;
    } else {
        text = text.replace(/^[a-z+]+:\/\//i, "");
        // credentials and ports never belong to a project's identity
        text = text.replace(/^[^@/]*@/, "");
        text = text.replace(/^([^/:]+):\d+\//, "$1/");
    }
    // Cut at the first `?` or `#` and collapse slash runs before taking the trailing one: `/[?#].*$/` and `/\/+$/` retried
    // from every `#` or `/` in a long remote, quadratic in its length.
    const query = text.search(/[?#]/);
    text = (query === -1 ? text : text.slice(0, query))
        .replace(/\/+/g, "/")
        .replace(/\/$/, "")
        .replace(/\.git$/i, "")
        .toLowerCase();
    return text.length <= PROJECT_ID_MAX && PROJECT_ID.test(text) ? text : undefined;
};
