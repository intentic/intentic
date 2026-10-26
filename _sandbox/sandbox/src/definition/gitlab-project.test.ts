import { gitHostOf } from "../capabilities/cli/git-access.js";
import { createGitlabProject, type GitlabFetch } from "./gitlab-project.js";

// Publishing to a self-hosted GitLab over plain http with a project access token answered a bare 400
// {"namespace":["is not valid"]}: a bot user may create nothing in its own namespace. The namespace is now chosen first.

const host = gitHostOf({ provider: "gitlab", url: "http://192.168.0.168", token: "glpat", git: "on" });

interface Call {
    readonly method: string;
    readonly url: string;
    readonly body?: unknown;
}

// Answers by "METHOD path" (query included), records every call.
const fakeGitlab = (answers: Record<string, unknown>) => {
    const calls: Call[] = [];
    const fetcher: GitlabFetch = async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push(init?.body === undefined ? { method, url } : { method, url, body: JSON.parse(init.body) });
        const key = `${method} ${url.replace(host.apiBase, "")}`;
        if (!(key in answers)) {
            return new Response(JSON.stringify({ message: "404 Not Found" }), { status: 404 });
        }
        return new Response(JSON.stringify(answers[key]), { status: 200 });
    };
    return { calls, fetcher };
};

const createdAt = (path: string) => ({ path_with_namespace: path, http_url_to_repo: `http://gitlab.internal/${path}.git` });

test("a person's token creates in its own namespace, and the clone URL is on the card's own address", async () => {
    const { calls, fetcher } = fakeGitlab({ "GET /user": { bot: false }, "POST /projects": createdAt("artur/ws") });

    expect(await createGitlabProject(host, "ws", undefined, fetcher)).toBe("http://192.168.0.168/artur/ws.git");
    expect(calls.at(-1)?.body).toEqual({ name: "ws", path: "ws", visibility: "private" });
});

test("a group access token creates in the group its bot belongs to", async () => {
    const { calls, fetcher } = fakeGitlab({
        "GET /user": { bot: true },
        "GET /groups?min_access_level=30&per_page=100": [
            { id: 12, full_path: "egnet/sub" },
            { id: 7, full_path: "egnet" },
        ],
        "POST /projects": createdAt("egnet/ws"),
    });

    expect(await createGitlabProject(host, "ws", undefined, fetcher)).toBe("http://192.168.0.168/egnet/ws.git");
    expect(calls.at(-1)?.body).toEqual({ name: "ws", path: "ws", visibility: "private", namespace_id: 7 });
});

test("a project access token creates nothing and says which project it can push to", async () => {
    const { calls, fetcher } = fakeGitlab({
        "GET /user": { bot: true },
        "GET /groups?min_access_level=30&per_page=100": [],
        "GET /projects?membership=true&per_page=20": [{ path_with_namespace: "egnet/dyspozytornia" }],
    });

    const refusal = createGitlabProject(host, "ws", undefined, fetcher);

    await expect(refusal).rejects.toThrow(/project access token.*egnet\/dyspozytornia.*paste its URL/su);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
});

test("a named owner is looked up by path and created in", async () => {
    const { calls, fetcher } = fakeGitlab({
        "GET /namespaces/egnet%2Fteam": { id: 31, full_path: "egnet/team" },
        "POST /projects": createdAt("egnet/team/ws"),
    });

    expect(await createGitlabProject(host, "ws", "egnet/team", fetcher)).toBe("http://192.168.0.168/egnet/team/ws.git");
    expect(calls.at(-1)?.body).toEqual({ name: "ws", path: "ws", visibility: "private", namespace_id: 31 });
});

test("an owner the token cannot see is named in the refusal", async () => {
    const { fetcher } = fakeGitlab({});

    await expect(createGitlabProject(host, "ws", "nobody", fetcher)).rejects.toThrow('no group or user "nobody"');
});
