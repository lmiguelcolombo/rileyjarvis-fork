# Computer use

How Jarvis controls the desktop, and the constraints that shaped it. Read this before changing computer-use tools, screenshots, mouse or keyboard input, the PowerShell worker, OCR, UI Automation, or the Computer Use section of `JARVIS_INSTRUCTIONS`.

## Flow

The Realtime model calls a tool → `src/lib/realtime.ts` forwards it over IPC → the `tools:execute` handler in `electron/main.cjs` runs it, delegating Windows work to `electron/computer-windows.cjs` → the result goes back to the model as a `function_call_output`. A result carrying `modelImage` is followed by a user `input_image` item, which is how the model sees screenshots.

## Targeting: the model sees but can't ground

gpt-realtime can read a screenshot, but it can't **ground** pixels. Its coordinate guesses for a row at y≈293 ranged from 190 to 255. Every targeting tool therefore resolves an exact position on the machine, and the model picks _what_ to click, never _where_. In order of preference:

1. **Text**: `computer_click_text` and the numbered `text_on_screen` list from `screen_snapshot`. Windows OCR (`Windows.Media.Ocr`, profile languages) on a fresh physical-resolution capture. Matching folds case, accents and punctuation, because OCR drops diacritics ("Luís" reads as "Luis"). Works in apps that expose no accessibility tree (WhatsApp, which is WebView2).
2. **Element**: `ui_elements` → `computer_click_item`. UI Automation bounding boxes for icons and controls with no visible text. Chromium-based apps may expose web content only after the first query, or not at all.
3. **Coordinates**: `computer_click`, the last resort, for targets with neither text nor an element.

A new targeting capability joins this ladder as a tool that resolves the position itself.

## Coordinate spaces

- **Physical pixels**: what `SendInput`/`SetCursorPos` take, what UIA rects report (the worker is per-monitor DPI aware), and what OCR returns on our captures. Item maps (`targets`) store physical boxes.
- **Snapshot image space**: the downscaled JPEG the model sees (long side 1280). `computer_click` x/y and the `at (x, y)` hints in lists are in this space.
- Convert only through `snapshotGeometry`, which `captureScreen` sets. Everything assumes the primary display.

## The PowerShell worker

All Windows input and inspection runs in one long-lived `powershell.exe`. Spawning per action cost ~6s, which let the screen and the conversation move on between steps. A script sent through `runPowerShell` runs in a child scope of that worker, so:

- The helpers are already loaded: `[JarvisInput]`, `[JarvisWindow]`, UI Automation, `$OcrEngine`, `Wait-JarvisAsync`. New C# goes into `INPUT_HELPER`/`WINDOW_HELPER` or the worker boot script, so it compiles once.
- End a script early with `return`: `exit` kills the worker.
- Pass user-supplied values as `JARVIS_*` env vars (the second argument) and read them with `$env:`. Interpolate only numbers you computed.
- Write results with `Write-Output`; for structured data, `ConvertTo-Json -Compress`, parsed in JS. Throw to fail: the message becomes the tool error.
- A timed-out request kills the worker; the next call boots a new one (~0.7s).

## Realtime constraints

- Images go over the WebRTC data channel, which caps message size. `modelImage` stays under ~180 KB (JPEG quality steps down to fit). `sendEvent` refuses oversize payloads.
- Request responses only through `requestResponse()`. A `response.create` sent while a response is active is rejected, which happens whenever Luis speaks during a tool call.
- Tool messages are the model's only view of what happened. State the outcome it needs to self-correct, like the window that received typed text or the other matches for a text query.

## Testing on Windows

Exercise changes with Windows Node, which spawns the worker the way Electron does. WSL Node can't: the worker script goes to `os.tmpdir()`. Write a throwaway harness in `data/` (gitignored) that stubs `electron` and appends exports for the internals you need:

```js
const Module = require("module"); const fs = require("fs"); const path = require("path");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "electron" ? {} : load.call(this, request, ...rest); };
const file = path.join(__dirname, "..", "electron", "computer-windows.cjs");
const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.t = { runPowerShell, recognizeText, findTextMatches };", file);
```

Run it with `cmd.exe /c "node data\\harness.cjs"`, then delete it. Test targeting against real screenshots saved in `data/` by earlier sessions. Clicks and keystrokes land on Luis's live desktop, so stick to read-only calls (OCR, `ui_elements`, `inspectUi`, `typeText("")`) unless Luis agrees to a live test.
