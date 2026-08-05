import { expect, test } from "vitest";
import { stateDir } from "./backing-ssh.js";

/* stateDir's output is a path built by concatenation, and composeDown ends with `rm -rf` on it. So the thing
 * worth testing is not the happy slug — it is that no input can make the path name the PARENT of every
 * instance instead of one instance. */

test("a node id becomes one directory inside the kind's directory", () => {
    expect(stateDir("postgres", "app-db")).toBe("/opt/intentic/postgres/app-db");
    expect(stateDir("postgres", "App_DB 2")).toBe("/opt/intentic/postgres/app-db-2");
});

test.each([["---"], ["__"], [" "], [""], ["!!!"]])("an id with nothing to slug (%j) is refused, not widened to the parent directory", (id) => {
    // Without the guard these returned "/opt/intentic/postgres/" — and `rm -rf` on that is every postgres
    // instance on the host, deleted while reconciling a single node.
    expect(() => stateDir("postgres", id)).toThrow(/no letters or digits/);
});
