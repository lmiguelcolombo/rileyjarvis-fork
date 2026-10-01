// Windows implementations of Ricky's computer-use tools.
// Input and UI inspection go through PowerShell + Win32 (no native Node modules);
// screenshots use Electron's desktopCapturer.
const { desktopCapturer, screen } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");

const execFileAsync = promisify(execFile);

const INPUT_HELPER = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class RickyInput {
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

public static class RickyWindow {
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

// User-supplied values are passed as RICKY_* environment variables, never interpolated into the script.
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
    `$name = $env:RICKY_APP_NAME
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
    { RICKY_APP_NAME: name },
  );
}

async function typeText(text) {
  await runPowerShell(`${addType(INPUT_HELPER)}\n[RickyInput]::TypeText($env:RICKY_TEXT)`, { RICKY_TEXT: text }, 30000 + text.length * 20);
}

async function pressKey(key, repeat) {
  const vk = VIRTUAL_KEYS[String(key || "").toLowerCase()];
  if (!vk) throw new Error(`Unsupported key: ${key}`);
  await runPowerShell(`${addType(INPUT_HELPER)}\n[RickyInput]::PressKey(${vk}, ${Math.trunc(repeat)})`);
}

async function click(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be numbers.");
  await runPowerShell(`${addType(INPUT_HELPER)}\n[RickyInput]::Click(${Math.round(x)}, ${Math.round(y)})`);
}

async function scroll(direction, amount) {
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "up" || direction === "right" ? 1 : -1;
  const delta = sign * 120 * Math.trunc(amount);
  await runPowerShell(`${addType(INPUT_HELPER)}\n[RickyInput]::Scroll(${delta}, $${horizontal})`);
}

// Captures the primary display at physical resolution, writes a PNG, and returns a data URL for the artifact panel.
async function captureScreen(screenshotPath) {
  const display = screen.getPrimaryDisplay();
  const thumbnailSize = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
  const source = sources.find((item) => item.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("Screen capture returned no image.");
  await fs.writeFile(screenshotPath, source.thumbnail.toPNG());
  return source.thumbnail.toDataURL();
}

async function inspectUi() {
  return runPowerShell(`${addType(WINDOW_HELPER)}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$hwnd = [RickyWindow]::GetForegroundWindow()
$title = New-Object System.Text.StringBuilder 512
[void][RickyWindow]::GetWindowText($hwnd, $title, $title.Capacity)
$processId = [uint32]0
[void][RickyWindow]::GetWindowThreadProcessId($hwnd, [ref]$processId)
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

module.exports = { openApp, typeText, pressKey, click, scroll, captureScreen, inspectUi };
