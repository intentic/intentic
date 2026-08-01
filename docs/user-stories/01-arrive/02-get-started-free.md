# Get in without filling anything in

As someone who has decided to try this, I want signing in to be one click and no form, so that the first thing the product asks of me is not twenty seconds of typing.

There is exactly one way in, and it is my Google account. No password to invent, no email to confirm, no plan to choose before I have seen anything. The screen says which product I am signing into and what I am agreeing to, and the terms are readable before I agree rather than after.

Where I land afterwards depends on what I already have. With no sandbox yet I go to setup, because an empty workspace would be a room with nothing in it. With one already running I go straight to the workspace. And if I arrived on a deep link while signed out, signing in should not have cost me the page I was trying to reach.

## Acceptance criteria

- [ ] The sign-in screen names the product and offers a single action, "Continue with Google" — no password field and no registration form
- [ ] The Terms and Privacy links are present, open in a new tab, and resolve to real pages
- [ ] Visiting a signed-in area while signed out lands on the sign-in screen rather than a blank page or an error
- [ ] Signing in with an account that has no sandbox opens the setup flow, not an empty workspace
- [ ] Signing in with an account that already has a sandbox opens the workspace
- [ ] The sign-in screen is usable at a phone-width viewport, with the action still reachable without horizontal scrolling
- [ ] Cancelling or dismissing the Google sign-in window leaves the page usable and the action clickable again, rather than stuck in a loading state
