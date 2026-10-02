# Code conventions

- **Platform parity.** Jarvis runs on macOS and Windows. Every computer tool in `electron/main.cjs` has a macOS branch (osascript, `screencapture`) and a Windows branch that delegates to `electron/computer-windows.cjs`. `JARVIS_INSTRUCTIONS` and tool descriptions are shared by both platforms, so guidance that steers the model toward a platform-only tool is built per platform, and the tool's description says "Windows only" or "macOS only".
- **Tool results.** A tool returns `{ ok: true, ...fields }` or `{ ok: false, error }`, with camelCase field names. Helpers throw; the catch at the end of the `tools:execute` handler turns the throw into `{ ok: false, error }`. Everything except `artifact` content and `modelImage` reaches the model as JSON (`sanitizeToolResult` in `src/lib/realtime.ts`), so field names and messages are written for the model to read.
- **Comments.** Match the file: the upstream code is almost comment-free. Write one-line comments that state a non-obvious constraint or reason. How a bug was found belongs in the commit body.
- **README.md** is the user's manual: setup, env vars, permissions, platform notes, what computer use can do. A change to any of those updates the README in the same commit.

# Verifying changes

There is no test suite. A change is verified when:

- `npm run typecheck` is clean. From WSL, run npm through Windows (`cmd.exe /c "npm run typecheck"`): `node_modules` is installed for Windows.
- Every changed `.cjs` file passes `node --check` (the Electron main process isn't typechecked).
- Changed behaviour was exercised for real, or the report to Luis says it wasn't.

# Version control

The git log is this project's decision record: every change is an **atomic** commit, pushed as soon as it lands.

- **Atomic** = one logical change (a fix, a feature, a dependency bump, a doc update) that stands and reverts on its own. When the working tree holds several changes, stage them separately (per file, or `git add -p`). A dependency change carries `package.json` and `package-lock.json` together.
- Commit each change the moment it is done, then `git push origin main`. This is a solo fork; `main` is the working branch.
- Subject: imperative, ≤72 chars, conventional prefix (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- Body: the _why_ — root cause for fixes, the decision taken and alternatives rejected for features. Someone running `git log` later should be able to reconstruct the reasoning without this conversation.
- Done = `git status` shows no uncommitted changes of yours and `main` level with `origin/main`.

# Diagnosing Jarvis

To see what Jarvis heard, said, and did, read `data/jarvis-log-YYYY-MM-DD.jsonl`: one JSON line per speech transcript, reply, tool call (with arguments), tool result, and Realtime error. It is written only while `.env.local` has `JARVIS_DEBUG_LOG=1`, a validation-time switch Luis turns off afterwards. Screenshots from the same session sit beside it in `data/`.
