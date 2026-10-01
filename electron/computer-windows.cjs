// Windows implementations of Jarvis's computer-use tools.
// Input and UI inspection go through PowerShell + Win32 (no native Node modules);
// screenshots use Electron's desktopCapturer.
const { desktopCapturer, screen } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");

const execFileAsync = promisify(execFile);

// The model sees a downscaled JPEG of the screen; clicks arrive in that image's pixel space.
// Realtime vision downsamples large images anyway, and the data channel caps message size.
const MODEL_IMAGE_MAX_SIDE = 1280;
const MODEL_IMAGE_MAX_BYTES = 180000;
let snapshotGeometry = null;
// Element boxes from the last listUiElements() call, in physical pixels, keyed by the id shown to the model.
let uiElements = new Map();
const MAX_UI_ELEMENTS = 150;

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
  const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000;

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

  public static void Click(int x, int y) {
    UsePhysicalPixels();
    if (!SetCursorPos(x, y)) throw new Win32Exception(Marshal.GetLastWin32Error());
    Send(Mouse(MOUSEEVENTF_LEFTDOWN, 0), Mouse(MOUSEEVENTF_LEFTUP, 0));
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

// User-supplied values are passed as JARVIS_* environment variables, never interpolated into the script.
async function runPowerShell(body, env = {}, timeout = 30000) {
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
${body}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, ...env }, windowsHide: true, timeout },
    );
    return stdout.replace(/\r\n/g, "\n").trim();
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
}

async function openApp(appName) {
  const name = appName.trim();
  if (!name) throw new Error("appName is required.");
  return runPowerShell(
    `$name = $env:JARVIS_APP_NAME
try {
  Start-Process -FilePath $name
  Write-Output $name
  exit 0
} catch {}
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

async function typeText(text) {
  await runPowerShell(`${addType(INPUT_HELPER)}\n[JarvisInput]::TypeText($env:JARVIS_TEXT)`, { JARVIS_TEXT: text }, 30000 + text.length * 20);
}

async function pressKey(key, repeat) {
  const vk = VIRTUAL_KEYS[String(key || "").toLowerCase()];
  if (!vk) throw new Error(`Unsupported key: ${key}`);
  await runPowerShell(`${addType(INPUT_HELPER)}\n[JarvisInput]::PressKey(${vk}, ${Math.trunc(repeat)})`);
}

// x/y are pixel coordinates in the last screen_snapshot image sent to the model.
async function click(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be numbers.");
  if (!snapshotGeometry) throw new Error("Take a screen_snapshot first; click coordinates are read from that image.");
  const { width, height, scaleX, scaleY } = snapshotGeometry;
  if (x < 0 || y < 0 || x > width || y > height) {
    throw new Error(`(${x}, ${y}) is outside the ${width}x${height} snapshot. Use coordinates from the snapshot image.`);
  }
  await runPowerShell(`${addType(INPUT_HELPER)}\n[JarvisInput]::Click(${Math.round(x * scaleX)}, ${Math.round(y * scaleY)})`);
}

async function clickElement(id) {
  const element = uiElements.get(Math.trunc(Number(id)));
  if (!element) throw new Error(`No element #${id}. Call ui_elements again; the list resets after each call.`);
  const x = Math.round(element.x + element.w / 2);
  const y = Math.round(element.y + element.h / 2);
  await runPowerShell(`${addType(INPUT_HELPER)}\n[JarvisInput]::Click(${x}, ${y})`);
  return element;
}

async function scroll(direction, amount) {
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "up" || direction === "right" ? 1 : -1;
  const delta = sign * 120 * Math.trunc(amount);
  await runPowerShell(`${addType(INPUT_HELPER)}\n[JarvisInput]::Scroll(${delta}, $${horizontal})`);
}

// Captures the primary display at physical resolution and writes a PNG. Returns a full-size data URL
// for the artifact panel and a smaller JPEG for the model, whose geometry click() maps back from.
async function captureScreen(screenshotPath) {
  const display = screen.getPrimaryDisplay();
  const thumbnailSize = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
  const source = sources.find((item) => item.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("Screen capture returned no image.");
  const image = source.thumbnail;
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
  return {
    displayUrl: image.toDataURL(),
    modelImage: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    width,
    height,
  };
}

async function inspectUi() {
  return runPowerShell(`${addType(WINDOW_HELPER)}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$hwnd = [JarvisWindow]::GetForegroundWindow()
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
  const output = await runPowerShell(`${addType(INPUT_HELPER)}
${addType(WINDOW_HELPER)}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
[JarvisInput]::UsePhysicalPixels()
$A = [System.Windows.Automation.AutomationElement]
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
  uiElements = new Map(elements.map((element, index) => [index + 1, element]));

  const lines = elements.map((element, index) => {
    const name = String(element.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const center = snapshotGeometry
      ? ` at (${Math.round((element.x + element.w / 2) / snapshotGeometry.scaleX)}, ${Math.round((element.y + element.h / 2) / snapshotGeometry.scaleY)})`
      : "";
    return `[${index + 1}] ${element.type}${name ? ` "${name}"` : ""}${center}${element.enabled === false ? " (disabled)" : ""}`;
  });
  return { window: String(result.window || ""), count: elements.length, list: lines.join("\n") };
}

module.exports = { openApp, typeText, pressKey, click, clickElement, scroll, captureScreen, inspectUi, listUiElements };
