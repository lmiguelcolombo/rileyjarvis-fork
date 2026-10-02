// Windows implementations of Jarvis's computer-use tools.
// Input and UI inspection go through a long-lived PowerShell worker + Win32 (no native Node modules);
// screenshots use Electron's desktopCapturer.
const { desktopCapturer, screen } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// The model sees a downscaled JPEG of the screen; clicks arrive in that image's pixel space.
// Realtime vision downsamples large images anyway, and the data channel caps message size.
const MODEL_IMAGE_MAX_SIDE = 1280;
const MODEL_IMAGE_MAX_BYTES = 180000;
let snapshotGeometry = null;
// Clickable items (UI Automation elements or OCR text) from the last ui_elements or screen_snapshot call,
// in physical pixels, keyed by the number shown to the model.
let targets = new Map();
const MAX_UI_ELEMENTS = 150;
const MAX_TEXT_ITEMS = 150;

const INPUT_HELPER = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class JarvisInput {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public InputUnion u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr processId);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint threadId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanEx(char c, IntPtr layout);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint MapVirtualKeyEx(uint code, uint mapType, IntPtr layout);
  [DllImport("user32.dll")] static extern short GetKeyState(int vk);

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const ushort VK_SHIFT = 0x10;
  const int VK_CAPITAL = 0x14;
  const uint MAPVK_VK_TO_VSC = 0, MAPVK_VK_TO_CHAR = 2;
  public const int TypeDelayMs = 8;
  const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
  const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x20, MOUSEEVENTF_MIDDLEUP = 0x40, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000;

  // Use physical pixels so coordinates match screen_snapshot images on scaled displays.
  public static void UsePhysicalPixels() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) {}
    SetProcessDPIAware();
  }

  static void Send(params INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput was blocked. The target window may be running as administrator.");
    }
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = vk;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = flags;
    return input;
  }

  static INPUT Mouse(uint flags, uint data) {
    INPUT input = new INPUT();
    input.type = INPUT_MOUSE;
    input.u.mi.dwFlags = flags;
    input.u.mi.mouseData = data;
    return input;
  }

  static bool IsExtended(ushort vk) {
    return vk >= 0x21 && vk <= 0x2E;
  }

  public static void PressKey(ushort vk, int repeat) {
    uint extended = IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
    for (int i = 0; i < repeat; i++) {
      Send(Key(vk, 0, extended), Key(vk, 0, extended | KEYEVENTF_KEYUP));
    }
  }

  // Types each character as a real keystroke on the target window's layout, falling back to
  // VK_PACKET only for characters the layout can't produce. Chromium/WinUI apps read queued
  // VK_PACKET events lazily and can repeat the last character ("Hello ddddd"), so we also pace input.
  public static void TypeText(string text) {
    uint threadId = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    IntPtr layout = GetKeyboardLayout(threadId);
    bool capsLock = (GetKeyState(VK_CAPITAL) & 1) != 0;
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      if (c == '\\r') continue;
      if (c == '\\n') PressKey(0x0D, 1);
      else if (c == '\\t') PressKey(0x09, 1);
      else if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) {
        char low = text[++i];
        Send(Key(0, c, KEYEVENTF_UNICODE), Key(0, low, KEYEVENTF_UNICODE),
             Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP), Key(0, low, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
      }
      else if (!TypeWithLayout(c, layout, capsLock)) {
        Send(Key(0, c, KEYEVENTF_UNICODE), Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
      }
      Thread.Sleep(TypeDelayMs);
    }
  }

  static bool TypeWithLayout(char c, IntPtr layout, bool capsLock) {
    short scan = VkKeyScanEx(c, layout);
    if (scan == -1) return false;
    ushort vk = (ushort)(scan & 0xFF);
    int mods = (scan >> 8) & 0xFF;
    // Skip Ctrl/Alt (AltGr) combos, which can trigger shortcuts, and dead keys, which would compose.
    if ((mods & 0x06) != 0 || (MapVirtualKeyEx(vk, MAPVK_VK_TO_CHAR, layout) & 0x80000000) != 0) return false;
    bool shift = (mods & 0x01) != 0;
    if (capsLock && vk >= 0x41 && vk <= 0x5A) shift = !shift;
    ushort hw = (ushort)MapVirtualKeyEx(vk, MAPVK_VK_TO_VSC, layout);
    if (shift) {
      ushort shiftScan = (ushort)MapVirtualKeyEx(VK_SHIFT, MAPVK_VK_TO_VSC, layout);
      Send(Key(VK_SHIFT, shiftScan, 0), Key(vk, hw, 0), Key(vk, hw, KEYEVENTF_KEYUP), Key(VK_SHIFT, shiftScan, KEYEVENTF_KEYUP));
    } else {
      Send(Key(vk, hw, 0), Key(vk, hw, KEYEVENTF_KEYUP));
    }
    return true;
  }

  // button: 0 = left, 1 = right, 2 = middle. Pauses let the target see the hover before the press
  // (Chromium can drop a click that lands with the move) while keeping double clicks within the double-click time.
  public static void Click(int x, int y, int button, int count) {
    UsePhysicalPixels();
    if (!SetCursorPos(x, y)) throw new Win32Exception(Marshal.GetLastWin32Error());
    uint down = button == 1 ? MOUSEEVENTF_RIGHTDOWN : button == 2 ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
    uint up = button == 1 ? MOUSEEVENTF_RIGHTUP : button == 2 ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
    Thread.Sleep(50);
    for (int i = 0; i < count; i++) {
      if (i > 0) Thread.Sleep(60);
      Send(Mouse(down, 0));
      Thread.Sleep(20);
      Send(Mouse(up, 0));
    }
  }

  public static void Scroll(int delta, bool horizontal) {
    Send(Mouse(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, unchecked((uint)delta)));
  }
}
`;

const WINDOW_HELPER = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class JarvisWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
}
`;

const VIRTUAL_KEYS = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  // Matches macOS "delete" (key code 51), which is Backspace.
  delete: 0x08,
  space: 0x20,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
};

function addType(source) {
  return `Add-Type -TypeDefinition @'\n${source}\n'@`;
}

// Spawning PowerShell and compiling the C# helpers took ~6s per action, long enough for the screen and the
// conversation to move on between Jarvis's steps. The worker pays that cost once, then runs each request
// (a base64 JSON line on stdin) in a child scope and answers with "<id> ok|error <base64 output>".
const WORKER_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${addType(INPUT_HELPER)}
${addType(WINDOW_HELPER)}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
[JarvisInput]::UsePhysicalPixels()
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' } |
  Select-Object -First 1
function Wait-JarvisAsync($operation, [Type]$type) {
  $task = $AsTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait()
  $task.Result
}
$OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
[Console]::Out.WriteLine('READY')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
  $status = 'ok'
  try {
    foreach ($entry in $request.env.PSObject.Properties) { Set-Item -Path ('env:' + $entry.Name) -Value $entry.Value }
    $output = & ([scriptblock]::Create($request.script)) | Out-String
  } catch {
    $status = 'error'
    $output = $_.Exception.Message
  }
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$output))
  [Console]::Out.WriteLine(('{0} {1} {2}' -f $request.id, $status, $encoded))
}`;
const WORKER_BOOT_TIMEOUT_MS = 30000;

let worker = null;
let nextRequestId = 1;

function startWorker() {
  const pending = new Map();
  const state = { child: null, pending, ready: null };
  state.ready = (async () => {
    // -EncodedCommand would overflow the command-line limit with the C# sources inlined. The BOM makes
    // Windows PowerShell read the file as UTF-8.
    const scriptPath = path.join(os.tmpdir(), `jarvis-worker-${process.pid}.ps1`);
    await fs.writeFile(scriptPath, `\ufeff${WORKER_SCRIPT}`, "utf8");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      windowsHide: true,
    });
    state.child = child;
    let stdout = "";
    let stderr = "";
    await new Promise((resolve, reject) => {
      let booted = false;
      const bootTimer = setTimeout(() => child.kill(), WORKER_BOOT_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        let newline;
        while ((newline = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!booted) {
            if (line === "READY") {
              booted = true;
              clearTimeout(bootTimer);
              resolve();
            }
            continue;
          }
          const [id, status, encoded = ""] = line.split(" ");
          const request = pending.get(Number(id));
          if (!request) continue;
          pending.delete(Number(id));
          clearTimeout(request.timer);
          const output = Buffer.from(encoded, "base64").toString("utf8").replace(/\r\n/g, "\n").trim();
          if (status === "ok") request.resolve(output);
          else request.reject(new Error(output || "PowerShell command failed."));
        }
      });
      child.on("error", reject);
      child.on("exit", () => {
        clearTimeout(bootTimer);
        if (worker === state) worker = null;
        const error = new Error(stderr.trim() || "The PowerShell worker exited.");
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        pending.clear();
        if (!booted) reject(error);
      });
    });
  })();
  return state;
}

async function getWorker() {
  if (!worker) worker = startWorker();
  const current = worker;
  try {
    await current.ready;
  } catch (error) {
    if (worker === current) worker = null;
    throw error;
  }
  return current;
}

// Starts the worker ahead of the first action so Jarvis's first click doesn't pay the boot time.
function warmUp() {
  getWorker().catch((error) => console.error("PowerShell worker failed to start:", error));
}

// User-supplied values are passed as JARVIS_* environment variables, never interpolated into the script.
// A timed-out request kills the worker (PowerShell can't cancel a running command); the next call restarts it.
async function runPowerShell(body, env = {}, timeout = 30000) {
  const current = await getWorker();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      current.pending.delete(id);
      reject(new Error("PowerShell command timed out."));
      if (worker === current) worker = null;
      current.child.kill();
    }, timeout);
    current.pending.set(id, { resolve, reject, timer });
    current.child.stdin.write(`${Buffer.from(JSON.stringify({ id, script: body, env })).toString("base64")}\n`);
  });
}

async function openApp(appName) {
  const name = appName.trim();
  if (!name) throw new Error("appName is required.");
  return runPowerShell(
    `$name = $env:JARVIS_APP_NAME
$started = $false
try { Start-Process -FilePath $name; $started = $true } catch {}
if ($started) { Write-Output $name; return }
$pattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($name) + '*'
$app = Get-StartApps |
  Where-Object { $_.Name -like $pattern } |
  Sort-Object @{ Expression = { $_.Name -ne $name } }, @{ Expression = { $_.Name.Length } } |
  Select-Object -First 1
if (-not $app) { throw "Could not find an app named '$name'." }
Start-Process -FilePath ('shell:AppsFolder\\' + $app.AppID)
Write-Output $app.Name`,
    { JARVIS_APP_NAME: name },
  );
}

// Returns the title of the window that received the text, so Jarvis can tell when it typed into the wrong one.
async function typeText(text) {
  return runPowerShell(
    `[JarvisInput]::TypeText($env:JARVIS_TEXT)
$title = New-Object System.Text.StringBuilder 512
[void][JarvisWindow]::GetWindowText([JarvisWindow]::GetForegroundWindow(), $title, $title.Capacity)
Write-Output $title.ToString()`,
    { JARVIS_TEXT: text },
    30000 + text.length * 20,
  );
}

async function pressKey(key, repeat) {
  const vk = VIRTUAL_KEYS[String(key || "").toLowerCase()];
  if (!vk) throw new Error(`Unsupported key: ${key}`);
  await runPowerShell(`[JarvisInput]::PressKey(${vk}, ${Math.trunc(repeat)})`);
}

const MOUSE_BUTTONS = { left: 0, right: 1, middle: 2 };

function clickScript(x, y, options = {}) {
  const button = MOUSE_BUTTONS[options.button] ?? 0;
  const count = options.clicks === 2 ? 2 : 1;
  return `[JarvisInput]::Click(${x}, ${y}, ${button}, ${count})`;
}

// x/y are pixel coordinates in the last screen_snapshot image sent to the model.
async function click(x, y, options) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be numbers.");
  if (!snapshotGeometry) throw new Error("Take a screen_snapshot first; click coordinates are read from that image.");
  const { width, height, scaleX, scaleY } = snapshotGeometry;
  if (x < 0 || y < 0 || x > width || y > height) {
    throw new Error(`(${x}, ${y}) is outside the ${width}x${height} snapshot. Use coordinates from the snapshot image.`);
  }
  await runPowerShell(clickScript(Math.round(x * scaleX), Math.round(y * scaleY), options));
}

async function clickItem(id, options) {
  const item = targets.get(Math.trunc(Number(id)));
  if (!item) throw new Error(`No item #${id}. Call screen_snapshot or ui_elements again; each call renumbers the list.`);
  await runPowerShell(clickScript(Math.round(item.x + item.w / 2), Math.round(item.y + item.h / 2), options));
  return item;
}

// Folds case, accents and punctuation: Windows OCR drops diacritics ("Luís" reads as "Luis") and
// Jarvis hears names spoken, not spelled.
function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Finds OCR lines containing the query, boxed to the shortest run of words that matches. Whole-line
// matches come first (a chat named "meu amor" beats a preview reading "meu amor added..."), then reading order.
function findTextMatches(lines, query) {
  const wanted = normalizeText(query);
  if (!wanted) throw new Error("Give the text to click as it appears on screen.");
  const matches = [];
  for (const line of lines) {
    const words = line.words.map((word) => ({ ...word, norm: normalizeText(word.t) })).filter((word) => word.norm);
    const lineNorm = words.map((word) => word.norm).join(" ");
    if (!lineNorm.includes(wanted)) continue;
    let best = null;
    for (let start = 0; start < words.length; start++) {
      let joined = "";
      for (let end = start; end < words.length; end++) {
        joined = end === start ? words[end].norm : `${joined} ${words[end].norm}`;
        if (joined.includes(wanted)) {
          if (!best || end - start < best.end - best.start) best = { start, end };
          break;
        }
      }
    }
    const span = words.slice(best.start, best.end + 1);
    const left = Math.min(...span.map((word) => word.x));
    const top = Math.min(...span.map((word) => word.y));
    const right = Math.max(...span.map((word) => word.x + word.w));
    const bottom = Math.max(...span.map((word) => word.y + word.h));
    matches.push({ text: line.text, exact: lineNorm === wanted, x: left, y: top, w: right - left, h: bottom - top });
  }
  return matches.sort((a, b) => Number(b.exact) - Number(a.exact) || a.y - b.y || a.x - b.x);
}

// Clicks visible text found by OCR on a fresh capture, so Jarvis never has to estimate coordinates for
// anything with a label: contacts, links, menu items, buttons, placeholder text in input fields.
async function clickText(query, options = {}) {
  const ocrPath = path.join(os.tmpdir(), `jarvis-ocr-${process.pid}.png`);
  const { image } = await grabScreen();
  await fs.writeFile(ocrPath, image.toPNG());
  const lines = await recognizeText(ocrPath);
  const matches = findTextMatches(lines, query);
  if (matches.length === 0) {
    const visible = lines.slice(0, 60).map((line) => line.text).join(" | ");
    throw new Error(`"${query}" is not visible on screen. Visible text: ${visible}`);
  }
  const occurrence = Math.trunc(Number(options.occurrence || 1));
  if (occurrence < 1 || occurrence > matches.length) {
    throw new Error(`Only ${matches.length} match(es) for "${query}".`);
  }
  const match = matches[occurrence - 1];
  await runPowerShell(clickScript(Math.round(match.x + match.w / 2), Math.round(match.y + match.h / 2), options));
  return { clicked: match.text, occurrence, matches: matches.map((item) => item.text) };
}

// Runs Windows OCR (Windows.Media.Ocr, using the user's profile languages) on a PNG.
// Returns lines with per-word boxes in the image's pixels, which are physical screen pixels for our captures.
async function recognizeText(imagePath) {
  const output = await runPowerShell(
    `if (-not $OcrEngine) { throw 'Windows OCR is unavailable: no OCR language pack for the profile languages.' }
$file = Wait-JarvisAsync ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:JARVIS_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Wait-JarvisAsync ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Wait-JarvisAsync ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Wait-JarvisAsync ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Wait-JarvisAsync ($OcrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
} finally { $stream.Dispose() }
$lines = foreach ($line in $result.Lines) {
  [pscustomobject]@{ words = @($line.Words | ForEach-Object {
    $r = $_.BoundingRect
    [pscustomobject]@{ t = $_.Text; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }) }
}
ConvertTo-Json -Compress -Depth 4 -InputObject @($lines)`,
    { JARVIS_IMAGE: imagePath },
  );
  const parsed = JSON.parse(output || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map((line) => ({ words: Array.isArray(line.words) ? line.words : [line.words], text: "" }))
    .map((line) => ({ ...line, text: line.words.map((word) => word.t).join(" ") }))
    .filter((line) => line.words.length > 0 && line.text.trim());
}

function snapshotPoint(item) {
  if (!snapshotGeometry) return "";
  const x = Math.round((item.x + item.w / 2) / snapshotGeometry.scaleX);
  const y = Math.round((item.y + item.h / 2) / snapshotGeometry.scaleY);
  return ` at (${x}, ${y})`;
}

async function scroll(direction, amount) {
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "up" || direction === "right" ? 1 : -1;
  const delta = sign * 120 * Math.trunc(amount);
  await runPowerShell(`[JarvisInput]::Scroll(${delta}, $${horizontal})`);
}

async function grabScreen() {
  const display = screen.getPrimaryDisplay();
  const thumbnailSize = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
  const source = sources.find((item) => item.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("Screen capture returned no image.");
  return { image: source.thumbnail };
}

// Captures the primary display at physical resolution and writes a PNG. Returns a full-size data URL
// for the artifact panel, a smaller JPEG for the model (whose geometry click() maps back from), and the
// on-screen text found by OCR as a numbered list for computer_click_item.
async function captureScreen(screenshotPath) {
  const { image } = await grabScreen();
  await fs.writeFile(screenshotPath, image.toPNG());

  const physical = image.getSize();
  const ratio = Math.min(1, MODEL_IMAGE_MAX_SIDE / Math.max(physical.width, physical.height));
  const width = Math.round(physical.width * ratio);
  const height = Math.round(physical.height * ratio);
  const resized = ratio < 1 ? image.resize({ width, height, quality: "best" }) : image;
  let jpeg = resized.toJPEG(80);
  for (const quality of [65, 50, 35]) {
    if (jpeg.length <= MODEL_IMAGE_MAX_BYTES) break;
    jpeg = resized.toJPEG(quality);
  }
  snapshotGeometry = { width, height, scaleX: physical.width / width, scaleY: physical.height / height };

  let textList;
  try {
    const lines = (await recognizeText(screenshotPath)).slice(0, MAX_TEXT_ITEMS);
    const items = lines.map((line) => {
      const left = Math.min(...line.words.map((word) => word.x));
      const top = Math.min(...line.words.map((word) => word.y));
      const right = Math.max(...line.words.map((word) => word.x + word.w));
      const bottom = Math.max(...line.words.map((word) => word.y + word.h));
      return { type: "Text", name: line.text, x: left, y: top, w: right - left, h: bottom - top };
    }).sort((a, b) => a.y - b.y || a.x - b.x);
    targets = new Map(items.map((item, index) => [index + 1, item]));
    textList = items.map((item, index) => `[${index + 1}] "${item.name.slice(0, 80)}"${snapshotPoint(item)}`).join("\n");
  } catch (error) {
    textList = `Text recognition failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  return {
    displayUrl: image.toDataURL(),
    modelImage: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    width,
    height,
    textList,
  };
}

async function inspectUi() {
  return runPowerShell(`$hwnd = [JarvisWindow]::GetForegroundWindow()
$title = New-Object System.Text.StringBuilder 512
[void][JarvisWindow]::GetWindowText($hwnd, $title, $title.Capacity)
$processId = [uint32]0
[void][JarvisWindow]::GetWindowThreadProcessId($hwnd, [ref]$processId)
$appName = ''
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($process) {
  $appName = $process.ProcessName
  try { if ($process.MainModule.FileVersionInfo.FileDescription) { $appName = $process.MainModule.FileVersionInfo.FileDescription } } catch {}
}
$role = ''
try { $role = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd).Current.LocalizedControlType } catch {}
Write-Output ("App: " + $appName)
Write-Output ("Window: " + $title.ToString())
Write-Output ("Role: " + $role)`);
}

// Lists the foreground window's on-screen interactive elements with their exact bounding boxes via
// UI Automation, so clicks can target an element instead of a pixel estimated from a screenshot.
async function listUiElements() {
  const output = await runPowerShell(`$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$hwnd = [JarvisWindow]::GetForegroundWindow()
$title = New-Object System.Text.StringBuilder 512
[void][JarvisWindow]::GetWindowText($hwnd, $title, $title.Capacity)
$root = $A::FromHandle($hwnd)
$types = @($CT::Button, $CT::SplitButton, $CT::Edit, $CT::ComboBox, $CT::Hyperlink, $CT::MenuItem, $CT::TabItem,
  $CT::CheckBox, $CT::RadioButton, $CT::ListItem, $CT::TreeItem, $CT::DataItem)
$typeConditions = [System.Windows.Automation.Condition[]]@($types | ForEach-Object {
  [System.Windows.Automation.PropertyCondition]::new($A::ControlTypeProperty, $_) })
$condition = [System.Windows.Automation.AndCondition]::new(
  [System.Windows.Automation.OrCondition]::new($typeConditions),
  [System.Windows.Automation.PropertyCondition]::new($A::IsOffscreenProperty, $false))
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
$cache.Add($A::NameProperty)
$cache.Add($A::ControlTypeProperty)
$cache.Add($A::BoundingRectangleProperty)
$cache.Add($A::IsEnabledProperty)
$cache.Push()
try { $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) } finally { $cache.Pop() }
$items = foreach ($element in $found) {
  $info = $element.Cached
  $rect = $info.BoundingRectangle
  if ($rect.IsEmpty -or $rect.Width -lt 2 -or $rect.Height -lt 2) { continue }
  [pscustomobject]@{
    type = $info.ControlType.ProgrammaticName -replace '^ControlType\\.', ''
    name = $info.Name
    enabled = $info.IsEnabled
    x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height
  }
}
ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{ window = $title.ToString(); elements = @($items) })`);

  const result = JSON.parse(output || "{}");
  const elements = (Array.isArray(result.elements) ? result.elements : [])
    // Nameless elements are only useful when they are input fields.
    .filter((element) => String(element.name || "").trim() || element.type === "Edit" || element.type === "ComboBox")
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .slice(0, MAX_UI_ELEMENTS);
  targets = new Map(elements.map((element, index) => [index + 1, element]));

  const lines = elements.map((element, index) => {
    const name = String(element.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return `[${index + 1}] ${element.type}${name ? ` "${name}"` : ""}${snapshotPoint(element)}${element.enabled === false ? " (disabled)" : ""}`;
  });
  return { window: String(result.window || ""), count: elements.length, list: lines.join("\n") };
}

module.exports = { warmUp, openApp, typeText, pressKey, click, clickItem, clickText, scroll, captureScreen, inspectUi, listUiElements };
