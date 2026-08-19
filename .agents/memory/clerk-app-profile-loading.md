---
name: Clerk app-profile loading
description: Preventing post-OAuth loading hangs when Clerk identity is bridged to an app user
---

Only request the local app profile after Clerk reports both `isLoaded` and `isSignedIn`. Clear user-scoped query state whenever Clerk's user id changes, including its first resolved value, and render a retryable error instead of treating missing profile data as loading forever.

**Why:** A route-level app-profile query can run before Clerk finishes restoring the session cookie. Its 401 may remain cached after OAuth succeeds, leaving signed-in users on an endless loading screen.

**How to apply:** Any new authenticated shell or role gate that depends on the app's `/me`-style endpoint must use the shared Clerk-aware profile hook rather than enabling the query unconditionally.