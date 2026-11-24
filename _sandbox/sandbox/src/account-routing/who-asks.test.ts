import { turnProof } from "../seams/workload-stamp.js";
import { type RouteCallerDeps, routeCallerFrom } from "./who-asks.js";

// Who a send to another sandbox comes from: a conversation only with its turn proof, and the one person it acts for.

const deps = (people: Readonly<Record<string, readonly string[]>>, mayHandOn = true): RouteCallerDeps => ({
    peopleOf: (id) => people[id] ?? [],
    ownerEmail: async () => "Owner@Acme.test",
    mayHandOn: () => mayHandOn,
});

test("a proven conversation acting for one person routes as that person", async () => {
    expect(await routeCallerFrom(deps({ "brave-fox": ["ada@acme.test"] }), "brave-fox", turnProof("brave-fox"))).toEqual({
        conversationId: "brave-fox",
        people: ["ada@acme.test"],
        person: "ada@acme.test",
    });
});

test("a proven conversation acting for nobody acts for the owner", async () => {
    expect(await routeCallerFrom(deps({}), "job", turnProof("job"))).toEqual({ conversationId: "job", people: ["owner@acme.test"], person: "owner@acme.test" });
});

test("a name without its proof, or with another conversation's, is nobody: never the owner", async () => {
    const all = deps({ "brave-fox": ["ada@acme.test"] });
    expect(await routeCallerFrom(all, "brave-fox", undefined)).toEqual({ people: [] });
    expect(await routeCallerFrom(all, "brave-fox", turnProof("other"))).toEqual({ people: [] });
    expect(await routeCallerFrom(all, undefined, undefined)).toEqual({ people: [] });
});

test("a conversation acting for several people names none of them", async () => {
    const caller = await routeCallerFrom(deps({ child: ["bo@acme.test", "ada@acme.test"] }), "child", turnProof("child"));
    expect(caller).toEqual({ conversationId: "child", people: ["bo@acme.test", "ada@acme.test"] });
});

test("a turn that may not hand work on is refused, whoever it acts for", async () => {
    expect(await routeCallerFrom(deps({ x: ["ada@acme.test"] }, false), "x", turnProof("x"))).toMatchObject({ refused: expect.stringContaining("may not send") });
});
