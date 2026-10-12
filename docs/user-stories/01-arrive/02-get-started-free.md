# Get in without a registration form

As someone who has decided to try this, I want signing in to be one click or one short code, with no registration form, so that the first thing the product asks of me is not twenty seconds of typing.

There are two ways in. With a Google account it is one click. With any other address, on my own domain or my company's mail server, I type the address and get a six-digit code by email, which I type in or confirm from the link in the same mail. No password to invent, no registration form, no plan to choose before I have seen anything. The screen says which product I am signing into and what I am agreeing to, and the terms are readable before I agree rather than after.

Where I land afterwards depends on what I already have. With no sandbox yet I go to setup, because an empty workspace would be a room with nothing in it. With one already running I go straight to the workspace. And if I arrived on a deep link while signed out, signing in should not have cost me the page I was trying to reach.

## Acceptance criteria

- [ ] The sign-in screen names the product and offers "Continue with Google" and an email address field that sends a code: no password field and no registration form
- [ ] The emailed code works typed into the sign-in screen, and from the mail's link after one Confirm press on the page it opens
- [ ] A wrong or expired code says so and lets me ask for a new one, rather than failing without a word
- [ ] A platform that cannot send mail offers only "Continue with Google"
- [ ] The Terms and Privacy links are present, open in a new tab, and resolve to real pages
- [ ] Visiting a signed-in area while signed out lands on the sign-in screen rather than a blank page or an error
- [ ] Signing in with an account that has no sandbox opens the setup flow, not an empty workspace
- [ ] Signing in with an account that already has a sandbox opens the workspace
- [ ] The sign-in screen is usable at a phone-width viewport, with both ways in still reachable without horizontal scrolling
- [ ] Cancelling or dismissing the Google sign-in window leaves the page usable and the action clickable again, rather than stuck in a loading state
