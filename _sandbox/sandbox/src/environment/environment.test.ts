// What the Environment card is allowed to offer follows from the base this container was built on, and nothing else:
// a checkout-built base gets the rebuild-from-source offer, every published or pinned one must not (an update is that
// sandbox's update, and offering a rebuild from a checkout it has none of would be a dead button).
import { DEV_SANDBOX_IMAGE } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { containerFacts } from "./environment.js";
import { testConfig } from "../testing.js";

const facts = (sandbox: Partial<(typeof testConfig)["sandbox"]>) => containerFacts({ ...testConfig.sandbox, ...sandbox });

it("reports the dogfood base, with the checkout the runner recorded", () => {
    expect(facts({ baseImage: DEV_SANDBOX_IMAGE, devRoot: "/home/ada/intentic" }).localImage).toEqual({
        base: DEV_SANDBOX_IMAGE,
        root: "/home/ada/intentic",
    });
});

// The shape this very sandbox was in: connected with a dev image, so no checkout ever reached its env. The card still
// says what it runs; only the path to rebuild it is missing, and the UI asks for it in words rather than guessing.
it("reports the dogfood base with no checkout when none was recorded", () => {
    expect(facts({ baseImage: DEV_SANDBOX_IMAGE }).localImage).toEqual({ base: DEV_SANDBOX_IMAGE });
});

it("says nothing about a local image on a published base", () => {
    expect(facts({ baseImage: "ghcr.io/intentic/sandbox:stable" }).localImage).toBeUndefined();
});

// A rollback pin is a local tag too, and a rolled-back sandbox rejoins its channel by updating: offering it a rebuild
// from a checkout would point at one it hasn't got.
it("says nothing about a local image on a rollback pin", () => {
    expect(facts({ baseImage: "intentic-sandbox-rollback-demo:f6e917ce9b90" }).localImage).toBeUndefined();
});

// An overlay container's own tag is not a base; `baseImage` is what the runner stamped, and it wins.
it("reads the base the runner stamped, not the overlay tag the container runs", () => {
    expect(facts({ baseImage: DEV_SANDBOX_IMAGE, image: "intentic-sandbox-env-demo:335c0a435247" }).localImage).toEqual({ base: DEV_SANDBOX_IMAGE });
});

it("passes the overlay hash and container name through as the card's own anchors", () => {
    expect(facts({ environmentHash: "abc", name: "intentic-sandbox-demo" })).toEqual({ appliedHash: "abc", container: "intentic-sandbox-demo" });
});
