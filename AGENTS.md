# Version control

The git log is this project's decision record: every change is an **atomic** commit, pushed as soon as it lands.

- **Atomic** = one logical change (a fix, a feature, a dependency bump, a doc update) that stands and reverts on its own. When the working tree holds several changes, stage them separately (per file, or `git add -p`). A dependency change carries `package.json` and `package-lock.json` together.
- Commit each change the moment it is done, then `git push origin main`. This is a solo fork; `main` is the working branch.
- Subject: imperative, ≤72 chars, conventional prefix (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- Body: the _why_ — root cause for fixes, the decision taken and alternatives rejected for features. Someone running `git log` later should be able to reconstruct the reasoning without this conversation.
- Done = `git status` shows no uncommitted changes of yours and `main` level with `origin/main`.
