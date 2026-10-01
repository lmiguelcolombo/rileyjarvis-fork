const { app, BrowserWindow, ipcMain, nativeImage, screen } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const windowsComputer = require("./computer-windows.cjs");

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";
const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "jarvis-db.json");
// Pre-rename name of the database; migrated to dbPath on first run.
const legacyDbPath = path.join(dataDir, "ricky-db.json");
// Validation-only conversation log (JARVIS_DEBUG_LOG=1 in .env.local). Grows without bound; turn off when done.
const debugLogEnabled = process.env.JARVIS_DEBUG_LOG === "1";
let currentMode = "display";
let mainWindow = null;
let normalWindowBounds = null;
let dbWriteQueue = Promise.resolve();

const JARVIS_INSTRUCTIONS = `# Role and Objective
You are Jarvis, Luis's desktop AI operator. You speak through realtime voice and can use local tools.

# Personality and Tone
Concise, calm, useful. Use a confident man's voice. Talk like a smart operator, not a chatbot.

# Language
Speak Brazilian Portuguese (pt-BR) by default. Always reply in the language Luis last spoke: if Luis switches to English, answer in English until Luis switches back to Portuguese.

# Modes
- Display mode is the default. Use the app and artifact panel to show things. Do not control the computer.
- Computer use mode allows desktop control tools. Only use computer tools after the user asks for computer use or asks you to control the computer.

# Tool Behavior
- Use read-only tools when the user's intent is clear.
- When Luis says "show me the menu", "show me what I can do", or asks what Jarvis can do, call show_menu immediately.
- For web search, notes, charts, records, image generation, and artifact display, act directly when the request is clear.
- For thumbnail creation/editing, always use the thumbnail board tools, never generic image_generate and never artifact_show with imageLoading. Generate exactly one 16:9 image per request. Never generate multiple unless Luis separately asks again. Every generate/edit request gets a permanent database number that never changes, like #18 then #19 then #20. Do not renumber visible grid positions. Show paginated 3x3 pages of the permanent numbers. Do not show a standalone fullscreen loading animation for thumbnails. Use Luis's wording literally: do not invent elaborate extra concepts, fake text, or extra thumbnail ideas. For edits, use the exact existing numbered/selected image as input and make only the requested change.
- The thumbnail board persists across sessions. If Luis references thumbnail #N, trust that permanent number and call the matching thumbnail tool. Do not say you cannot see old thumbnails. Use thumbnail_grid to refresh state or change pages if needed.
- When a thumbnail finishes generating or editing, do not announce it verbally. The UI updates silently.
- For sending messages, deleting data, buying things, account changes, sharing private information, or anything irreversible, summarize the action and ask for explicit confirmation before calling the modifying tool.
- If a tool requires a confirmed field, set confirmed to true only after the user clearly confirms.
- Typing text and pressing Enter/Return in computer use mode are allowed without extra approval when Luis asks you to type or send a prompt. Ask first before clicking controls or taking actions that delete, purchase, change settings, or expose private information.
- Explain what you are doing in one short sentence before longer tool work. Do not over-explain.

# Computer Use
- Never guess where something is on screen. Call screen_snapshot and look at the image before clicking.
- To click, prefer ui_elements then computer_click_element: it uses the app's exact element positions. Match the element by name, type, and position in the snapshot.
- Fall back to computer_click only when the target is not in the ui_elements list (images, canvases, some web content). Its coordinates come from the most recent snapshot image. Aim for the center of the target.
- Element numbers are only valid until the next ui_elements call; list again after the screen changes.
- The screen changes after clicking, scrolling, typing, or opening apps: take a new snapshot before the next click, and after a click to confirm it worked.
- If a click missed, look at the new snapshot and correct the coordinates instead of repeating the same ones.

# Artifacts
Use artifacts for menus, web results, graphics, notes, database tables, code snippets, and task progress. If the user asks to show, hide, or fullscreen the artifacts panel, call the artifact tool.
For Mermaid charts, keep syntax simple: start with flowchart TD, avoid markdown fences, avoid parentheses in node labels, and use short alphanumeric node IDs.

# Audio
Let the user interrupt. If audio is unclear, ask one short clarifying question instead of guessing.`;

const toolSpecs = [
  {
    type: "function",
    name: "set_mode",
    description: "Switch Jarvis between display mode and computer use mode.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["display", "computer"] },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "artifact_show",
    description: "Show structured content in the artifact panel. Use for notes, menus, web results, charts, code, task progress, and visual content.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        kind: { type: "string", enum: ["text", "markdown", "code", "table", "notes", "mermaid", "image", "imageLoading", "thumbnailBoard", "progress"] },
        content: { type: "string" },
        language: { type: "string" },
        fullscreen: { type: "boolean" },
      },
      required: ["title", "kind", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "show_menu",
    description: "Show Jarvis's capability menu in the artifact panel. Call this when the user asks 'show me the menu', 'show me what I can do', or asks what Jarvis can do.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "web_search",
    description: "Search the web with Exa. Use for current facts, links, research, and source gathering. Results are shown as a clean Markdown research brief in the artifact panel.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        numResults: { type: "number", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "image_generate",
    description: "Generate a standalone image with GPT Image and show it in the artifact panel. Do not use for YouTube thumbnails, thumbnail edits, or the thumbnail board; use thumbnail_generate or thumbnail_edit instead.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024"] },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_reference_add",
    description: "Add a local image file as a reference image for making thumbnails of Luis. Use when Luis gives a file path to a photo of themselves.",
    parameters: {
      type: "object",
      properties: {
        imagePath: { type: "string" },
        label: { type: "string" },
      },
      required: ["imagePath"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_generate",
    description: "Generate exactly one 16:9 YouTube thumbnail into Jarvis's persistent paginated thumbnail board. Uses Luis reference images if available. Assigns a new permanent number that never changes. Never generate multiple at once.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_edit",
    description: "Edit one existing thumbnail by permanent thumbnail number, or edit the currently selected thumbnail if number is omitted. Use this whenever Luis says 'edit number 20' or 'edit this'. The edited result gets a new permanent number.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        number: { type: "number", minimum: 1 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_select",
    description: "Select a permanent numbered thumbnail and show it fullscreen. Use when Luis says 'pull up number 20', 'show number 20', 'open number 20', or 'select number 20'.",
    parameters: {
      type: "object",
      properties: {
        number: { type: "number", minimum: 1 },
      },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_grid",
    description: "Show one paginated 3x3 page of the persistent thumbnail board and return compact board state. Use to refresh state, change pages, or when Luis asks what thumbnails exist.",
    parameters: {
      type: "object",
      properties: {
        page: { type: "number", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "mermaid_render",
    description: "Render a Mermaid chart in the artifact panel. Provide only Mermaid code, no markdown fences. Prefer flowchart TD with quoted labels.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        diagram: { type: "string" },
      },
      required: ["title", "diagram"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "note_add",
    description: "Add a note to Jarvis's fun local notes list.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_create",
    description: "Create a local database record.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        title: { type: "string" },
        fields: { type: "object", additionalProperties: true },
      },
      required: ["collection", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_search",
    description: "Search local database records by collection and query.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        query: { type: "string" },
      },
      required: ["collection"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_update",
    description: "Update a local database record. Ask for confirmation first if the change is sensitive or destructive.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        fields: { type: "object", additionalProperties: true },
        confirmed: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_delete",
    description: "Delete a local database record. Always ask the user for explicit confirmation first, then call with confirmed true.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["id", "confirmed"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_open_app",
    description: "Open an app by name (on Windows: an executable, Start menu app name, or path). Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        appName: { type: "string" },
      },
      required: ["appName"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_type_text",
    description: "Type text into the active app. Requires computer mode. Do not ask for extra confirmation just to type.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        confirmed: { type: "boolean" },
        risk: { type: "string", enum: ["low", "may_send_or_modify", "private_or_sensitive"] },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_press_key",
    description: "Press a keyboard key in the active app. Requires computer mode. Use enter/return after typing when the user asks to send a prompt.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", enum: ["enter", "return", "tab", "escape", "delete", "space", "up", "down", "left", "right"] },
        repeat: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_click",
    description: "Click a point on screen. On Windows, x/y are pixel coordinates in the most recent screen_snapshot image. Requires computer mode. Ask for confirmation before clicking buttons that send, delete, buy, submit, or change settings.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left. Windows only." },
        clicks: { type: "number", enum: [1, 2], description: "2 for a double click. Windows only." },
        confirmed: { type: "boolean" },
        risk: { type: "string", enum: ["low", "may_send_or_modify", "private_or_sensitive"] },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_click_element",
    description: "Click the center of an element listed by ui_elements, using its exact on-screen position. Windows only. Requires computer mode. Ask for confirmation before clicking buttons that send, delete, buy, submit, or change settings.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "Element number from the latest ui_elements list." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left. Windows only." },
        clicks: { type: "number", enum: [1, 2], description: "2 for a double click. Windows only." },
        confirmed: { type: "boolean" },
        risk: { type: "string", enum: ["low", "may_send_or_modify", "private_or_sensitive"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_scroll",
    description: "Scroll the active app. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "screen_snapshot",
    description: "Capture the current screen. On Windows the screenshot is attached to the conversation so you can see it. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "ui_elements",
    description: "List the clickable elements (buttons, links, fields, tabs, menu items) visible in the foreground window, numbered for computer_click_element. Positions shown are in the latest screen_snapshot image. Windows only. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "ui_inspect",
    description: "Inspect the frontmost app name, window, and visible UI summary using Accessibility (macOS) or UI Automation (Windows) when available. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

async function ensureData() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    try {
      await fs.rename(legacyDbPath, dbPath);
      return;
    } catch {}
    await fs.writeFile(dbPath, JSON.stringify(defaultDb(), null, 2));
  }
}

async function readDb() {
  await ensureData();
  const raw = await fs.readFile(dbPath, "utf8");
  return normalizeDb(JSON.parse(raw));
}

async function writeDb(db) {
  await ensureData();
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function updateDb(mutator) {
  const operation = dbWriteQueue.then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return { db, result };
  });
  dbWriteQueue = operation.catch(() => {});
  return operation;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function defaultDb() {
  return {
    notes: [],
    records: [],
    thumbnailBoard: {
      references: [],
      images: [],
      nextNumber: 1,
      page: 1,
      pageSize: 9,
      selectedId: null,
      view: "grid",
    },
  };
}

function normalizeDb(db) {
  const next = db && typeof db === "object" ? db : defaultDb();
  if (!Array.isArray(next.notes)) next.notes = [];
  if (!Array.isArray(next.records)) next.records = [];
  if (!next.thumbnailBoard || typeof next.thumbnailBoard !== "object") {
    next.thumbnailBoard = defaultDb().thumbnailBoard;
  }
  if (!Array.isArray(next.thumbnailBoard.references)) next.thumbnailBoard.references = [];
  if (!Array.isArray(next.thumbnailBoard.images)) next.thumbnailBoard.images = [];
  let maxNumber = 0;
  for (const image of [...next.thumbnailBoard.images].reverse()) {
    if (!Number.isInteger(image.number) || image.number < 1) image.number = maxNumber + 1;
    maxNumber = Math.max(maxNumber, image.number);
  }
  if (!Number.isInteger(next.thumbnailBoard.nextNumber) || next.thumbnailBoard.nextNumber <= maxNumber) {
    next.thumbnailBoard.nextNumber = maxNumber + 1;
  }
  if (!Number.isInteger(next.thumbnailBoard.page) || next.thumbnailBoard.page < 1) next.thumbnailBoard.page = 1;
  if (!Number.isInteger(next.thumbnailBoard.pageSize) || next.thumbnailBoard.pageSize < 1) next.thumbnailBoard.pageSize = 9;
  if (typeof next.thumbnailBoard.view !== "string") next.thumbnailBoard.view = "grid";
  if (!("selectedId" in next.thumbnailBoard)) next.thumbnailBoard.selectedId = null;
  return next;
}

async function clearStartupLoadingThumbnails() {
  const db = await readDb();
  const before = db.thumbnailBoard.images.length;
  db.thumbnailBoard.images = db.thumbnailBoard.images.filter((image) => image.status !== "loading");
  if (db.thumbnailBoard.images.length !== before) {
    db.thumbnailBoard.selectedId = null;
    db.thumbnailBoard.view = "grid";
    await writeDb(db);
  }
}

function requireComputerMode() {
  if (currentMode !== "computer") {
    return {
      ok: false,
      needsMode: "computer",
      message: "Computer control is disabled. Ask Jarvis to switch to computer use mode first.",
    };
  }
  return null;
}

function requiresConfirmation(args) {
  return args.confirmed !== true && (args.risk === "may_send_or_modify" || args.risk === "private_or_sensitive");
}

function keyCodeForKey(key) {
  const keyCodes = {
    enter: 36,
    return: 36,
    tab: 48,
    escape: 53,
    delete: 51,
    space: 49,
    up: 126,
    down: 125,
    left: 123,
    right: 124,
  };
  return keyCodes[String(key || "").toLowerCase()] || null;
}

function appleScriptString(value) {
  return JSON.stringify(String(value)).replace(/\\\\/g, "\\");
}

async function createWindow() {
  await ensureData();
  await clearStartupLoadingThumbnails();
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    title: "Jarvis",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    icon: nativeImage.createEmpty(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(path.join(process.cwd(), "dist", "index.html"));
  }
}

function setWindowMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mode === "computer") {
    const currentBounds = mainWindow.getBounds();
    if (currentBounds.width > 400 && currentBounds.height > 400) {
      normalWindowBounds = currentBounds;
    }
    const cursorPoint = screen.getCursorScreenPoint();
    const targetDisplay = screen.getDisplayNearestPoint(cursorPoint) || screen.getDisplayMatching(currentBounds);
    const { workArea } = targetDisplay;
    const miniSize = 190;
    const margin = 18;
    mainWindow.setMinimumSize(150, 150);
    mainWindow.setResizable(false);
    mainWindow.setAlwaysOnTop(true, "floating");
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setBounds({
      x: workArea.x + margin,
      y: workArea.y + workArea.height - miniSize - margin,
      width: miniSize,
      height: miniSize,
    });
    return;
  }

  mainWindow.setAlwaysOnTop(false);
  mainWindow.setVisibleOnAllWorkspaces(false);
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(420, 520);
  if (normalWindowBounds) {
    mainWindow.setBounds(normalWindowBounds);
  } else {
    mainWindow.setBounds({ width: 1120, height: 760 });
    mainWindow.center();
  }
}

ipcMain.handle("tools:list", () => toolSpecs);

// One JSON line per transcript, tool call, tool result, or error, in data/jarvis-log-YYYY-MM-DD.jsonl.
ipcMain.on("debug:log", (_event, entry) => {
  if (!debugLogEnabled) return;
  const now = new Date();
  const line = JSON.stringify({ at: now.toISOString(), mode: currentMode, ...asObject(entry) });
  const logPath = path.join(dataDir, `jarvis-log-${now.toISOString().slice(0, 10)}.jsonl`);
  fs.appendFile(logPath, `${line}\n`).catch((error) => console.error("Failed to write debug log:", error));
});

ipcMain.handle("realtime:create-token", async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing in .env.local");
  }
  const db = await readDb();
  const instructions = `${JARVIS_INSTRUCTIONS}\n\n${buildThumbnailBoardInstructions(db)}`;

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": crypto.createHash("sha256").update("luis-local-jarvis").digest("hex"),
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: "gpt-realtime-2",
        instructions,
        output_modalities: ["audio"],
        reasoning: { effort: "low" },
        tool_choice: "auto",
        tools: toolSpecs,
        audio: {
          input: {
            turn_detection: {
              type: "semantic_vad",
              eagerness: "medium",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            voice: "cedar",
          },
        },
        tracing: {
          workflow_name: "Jarvis Desktop Companion",
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Realtime token request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const value = data.value || data.client_secret?.value;
  if (!value) {
    throw new Error("Realtime token response did not include a client secret value.");
  }
  return { value, expiresAt: data.expires_at || data.client_secret?.expires_at || null };
});

ipcMain.handle("tools:execute", async (_event, toolCall) => {
  const name = String(toolCall?.name || "");
  const args = asObject(toolCall?.arguments);

  try {
    if (name === "set_mode") {
      currentMode = args.mode === "computer" ? "computer" : "display";
      setWindowMode(currentMode);
      return {
        ok: true,
        mode: currentMode,
        artifact: {
          title: "Jarvis Mode",
          kind: "progress",
          content: `Mode switched to ${currentMode === "computer" ? "computer use" : "display"} mode.`,
        },
      };
    }

    if (name === "artifact_show") {
      return { ok: true, artifact: args };
    }

    if (name === "show_menu") {
      return {
        ok: true,
        artifact: {
          title: "Jarvis Menu",
          kind: "markdown",
          content: buildMenuMarkdown(),
        },
      };
    }

    if (name === "web_search") {
      return await webSearch(args);
    }

    if (name === "image_generate") {
      return await generateImage(args);
    }

    if (name === "thumbnail_loading_prepare") {
      return await thumbnailLoadingPrepare(args);
    }

    if (name === "thumbnail_reference_add") {
      return await thumbnailReferenceAdd(args);
    }

    if (name === "thumbnail_generate") {
      return await thumbnailGenerate(args);
    }

    if (name === "thumbnail_edit") {
      return await thumbnailEdit(args);
    }

    if (name === "thumbnail_select") {
      return await thumbnailSelect(args);
    }

    if (name === "thumbnail_grid") {
      const { db } = await updateDb(async (currentDb) => {
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = pageForArgs(args);
      });
      return { ok: true, board: thumbnailBoardSummary(db), artifact: await thumbnailBoardArtifact(db, "grid") };
    }

    if (name === "mermaid_render") {
      const diagram = normalizeMermaidDiagram(String(args.diagram || ""), String(args.title || "Mermaid chart"));
      return {
        ok: true,
        artifact: {
          title: String(args.title || "Mermaid chart"),
          kind: "mermaid",
          content: diagram,
        },
      };
    }

    if (name === "note_add") {
      const db = await readDb();
      const note = {
        id: crypto.randomUUID(),
        text: String(args.text || ""),
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        createdAt: new Date().toISOString(),
      };
      db.notes.unshift(note);
      await writeDb(db);
      return {
        ok: true,
        note,
        artifact: {
          title: "Fun Notes",
          kind: "notes",
          content: JSON.stringify(db.notes.slice(0, 20), null, 2),
        },
      };
    }

    if (name === "records_create") {
      const db = await readDb();
      const record = {
        id: crypto.randomUUID(),
        collection: String(args.collection || "default"),
        title: String(args.title || "Untitled"),
        fields: asObject(args.fields),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.records.unshift(record);
      await writeDb(db);
      return { ok: true, record, artifact: recordsArtifact(db.records, record.collection) };
    }

    if (name === "records_search") {
      const db = await readDb();
      const collection = String(args.collection || "default");
      const query = String(args.query || "").toLowerCase();
      const records = db.records.filter((record) => {
        if (record.collection !== collection) return false;
        if (!query) return true;
        return JSON.stringify(record).toLowerCase().includes(query);
      });
      return { ok: true, records, artifact: recordsArtifact(records, collection) };
    }

    if (name === "records_update") {
      const db = await readDb();
      const record = db.records.find((item) => item.id === args.id);
      if (!record) return { ok: false, error: "Record not found." };
      record.title = typeof args.title === "string" ? args.title : record.title;
      record.fields = { ...record.fields, ...asObject(args.fields) };
      record.updatedAt = new Date().toISOString();
      await writeDb(db);
      return { ok: true, record, artifact: recordsArtifact(db.records, record.collection) };
    }

    if (name === "records_delete") {
      if (args.confirmed !== true) {
        return { ok: false, requiresConfirmation: true, message: "Explicit confirmation is required before deleting a record." };
      }
      const db = await readDb();
      const before = db.records.length;
      db.records = db.records.filter((record) => record.id !== args.id);
      await writeDb(db);
      return { ok: true, deleted: before !== db.records.length, artifact: recordsArtifact(db.records, "All Records") };
    }

    if (name.startsWith("computer_") || name === "screen_snapshot" || name === "ui_inspect" || name === "ui_elements") {
      const blocked = requireComputerMode();
      if (blocked) return blocked;
      if (process.platform !== "darwin" && !isWindows) {
        return { ok: false, error: `Computer control is not supported on ${process.platform}.` };
      }
    }

    if (name === "computer_open_app") {
      if (isWindows) {
        const opened = await windowsComputer.openApp(String(args.appName || ""));
        return { ok: true, message: `Opened ${opened || args.appName}.` };
      }
      await execFileAsync("open", ["-a", String(args.appName || "")]);
      return { ok: true, message: `Opened ${args.appName}.` };
    }

    if (name === "computer_type_text") {
      if (isWindows) {
        await windowsComputer.typeText(String(args.text || ""));
      } else {
        await execFileAsync("osascript", ["-e", `tell application "System Events" to keystroke ${appleScriptString(args.text || "")}`]);
      }
      return { ok: true, message: "Typed text into the active app." };
    }

    if (name === "computer_press_key") {
      const keyCode = keyCodeForKey(args.key);
      if (!keyCode) {
        return { ok: false, error: `Unsupported key: ${args.key}` };
      }
      const repeat = Math.max(1, Math.min(20, Number(args.repeat || 1)));
      if (isWindows) {
        await windowsComputer.pressKey(args.key, repeat);
      } else {
        await execFileAsync("osascript", ["-e", `tell application "System Events" to repeat ${repeat} times\nkey code ${keyCode}\nend repeat`]);
      }
      return { ok: true, message: `Pressed ${args.key}.` };
    }

    if (name === "computer_click") {
      if (requiresConfirmation(args)) {
        return { ok: false, requiresConfirmation: true, message: "Confirmation required before clicking a risky target." };
      }
      if (isWindows) {
        await windowsComputer.click(Number(args.x), Number(args.y), { button: args.button, clicks: args.clicks });
      } else {
        await execFileAsync("osascript", ["-e", `tell application "System Events" to click at {${Number(args.x)}, ${Number(args.y)}}`]);
      }
      return { ok: true, message: `Clicked ${args.x}, ${args.y}.` };
    }

    if (name === "computer_click_element") {
      if (!isWindows) return { ok: false, error: "computer_click_element is only available on Windows." };
      if (requiresConfirmation(args)) {
        return { ok: false, requiresConfirmation: true, message: "Confirmation required before clicking a risky target." };
      }
      const element = await windowsComputer.clickElement(args.id, { button: args.button, clicks: args.clicks });
      return { ok: true, message: `Clicked #${args.id} ${element.type} "${element.name || ""}".` };
    }

    if (name === "ui_elements") {
      if (!isWindows) return { ok: false, error: "ui_elements is only available on Windows. Use ui_inspect." };
      const { window: windowTitle, count, list } = await windowsComputer.listUiElements();
      return {
        ok: true,
        window: windowTitle,
        count,
        elements: list || "No interactive elements found. Use screen_snapshot and computer_click instead.",
      };
    }

    if (name === "computer_scroll") {
      const direction = String(args.direction || "down");
      const amount = Math.max(1, Math.min(20, Number(args.amount || 4)));
      if (isWindows) {
        await windowsComputer.scroll(direction, amount);
        return { ok: true, message: `Scrolled ${direction}.` };
      }
      const keyByDirection = { up: 126, down: 125, left: 123, right: 124 };
      const keyCode = keyByDirection[direction] || 125;
      await execFileAsync("osascript", ["-e", `tell application "System Events" to repeat ${amount} times\nkey code ${keyCode}\nend repeat`]);
      return { ok: true, message: `Scrolled ${direction}.` };
    }

    if (name === "screen_snapshot") {
      await fs.mkdir(dataDir, { recursive: true });
      const screenshotPath = path.join(dataDir, `screenshot-${Date.now()}.png`);
      if (isWindows) {
        // file:// + a drive path doesn't load in the artifact panel, so show a data URL instead.
        const snapshot = await windowsComputer.captureScreen(screenshotPath);
        return {
          ok: true,
          path: screenshotPath,
          imageWidth: snapshot.width,
          imageHeight: snapshot.height,
          message: `The screenshot (${snapshot.width}x${snapshot.height}) is attached as the next message. computer_click x/y are pixel coordinates in this image.`,
          modelImage: snapshot.modelImage,
          artifact: {
            title: "Screen Snapshot",
            kind: "image",
            content: snapshot.displayUrl,
          },
        };
      }
      await execFileAsync("screencapture", ["-x", screenshotPath]);
      const imageContent = screenshotPath;
      return {
        ok: true,
        path: screenshotPath,
        artifact: {
          title: "Screen Snapshot",
          kind: "image",
          content: imageContent,
        },
      };
    }

    if (name === "ui_inspect" && isWindows) {
      const summary = await windowsComputer.inspectUi();
      return {
        ok: true,
        summary,
        artifact: {
          title: "UI Inspect",
          kind: "text",
          content: summary,
        },
      };
    }

    if (name === "ui_inspect") {
      const script = `tell application "System Events"
set frontApp to first application process whose frontmost is true
set appName to name of frontApp
set windowName to ""
try
  set windowName to name of front window of frontApp
end try
set roleSummary to ""
try
  set roleSummary to value of attribute "AXRoleDescription" of front window of frontApp
end try
return "App: " & appName & linefeed & "Window: " & windowName & linefeed & "Role: " & roleSummary
end tell`;
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      return {
        ok: true,
        summary: stdout.trim(),
        artifact: {
          title: "UI Inspect",
          kind: "text",
          content: stdout.trim(),
        },
      };
    }

    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

async function webSearch(args) {
  const exaKey = process.env.EXA_API_KEY;
  if (!exaKey) {
    return {
      ok: false,
      missingEnv: "EXA_API_KEY",
      message: "EXA_API_KEY is not set. Add it to .env.local to enable Jarvis's web search tool.",
    };
  }

  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": exaKey,
    },
    body: JSON.stringify({
      query: String(args.query || ""),
      type: "auto",
      numResults: Math.max(1, Math.min(10, Number(args.numResults || 5))),
      contents: { text: { maxCharacters: 900 } },
    }),
  });

  if (!response.ok) {
    return { ok: false, error: `Exa search failed: ${response.status} ${await response.text()}` };
  }
  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    ok: true,
    results,
    artifact: {
      title: `Web Search: ${args.query}`,
      kind: "markdown",
      content: formatSearchMarkdown(String(args.query || ""), results),
    },
  };
}

function formatSearchMarkdown(query, results) {
  const cleanQuery = query.trim() || "Search";
  if (results.length === 0) {
    return `# ${cleanQuery}\n\nNo strong web results came back for this search. Try a narrower query or ask Jarvis to search a specific site.`;
  }

  const sections = results.slice(0, 8).map((result, index) => {
    const title = cleanMarkdownText(result.title || result.url || `Result ${index + 1}`);
    const url = String(result.url || "");
    const source = cleanMarkdownText(result.author || hostname(url) || "Source");
    const text = cleanMarkdownText(result.text || result.summary || "").slice(0, 700);
    const published = result.publishedDate ? `\n- Published: ${cleanMarkdownText(result.publishedDate)}` : "";
    const link = url ? `[Open source](${url})` : "Source link unavailable";

    return `### ${index + 1}. ${title}\n\n${text || "No snippet was returned for this result."}\n\n- Source: ${source}${published}\n- ${link}`;
  });

  return [`# ${cleanQuery}`, `Jarvis found ${results.length} source${results.length === 1 ? "" : "s"}.`, ...sections].join(
    "\n\n",
  );
}

function cleanMarkdownText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function buildMenuMarkdown() {
  return `# Jarvis Menu

Here is what you can ask me to do.

## Voice and Conversation

- Talk naturally with Jarvis in realtime.
- Interrupt mid-response and ask follow-ups.
- Ask unrelated questions while tools keep running.

## Artifacts Panel

- "Show me the menu."
- "Show the artifacts panel."
- "Make that fullscreen."
- Show clean research briefs, notes, code snippets, charts, task progress, images, and records.

## Web and Research

- "Search the web for ..."
- "Look up the latest on ..."
- Results render as a clean Markdown brief with source links.

## Visuals

- Generate images with GPT Image.
- Create Mermaid charts with automatic fallback if the syntax breaks.
- Draft diagrams, code snippets, structured notes, and visual explanations.

## Notes and Records

- Add notes to Jarvis's local note grid.
- Create, search, update, and confirm-delete local database records.

## Computer Use Mode

- "Switch to computer use mode."
- Open apps, click (by on-screen element or by position), type, press Enter/Return, scroll, inspect the UI, and take screen snapshots.
- Jarvis asks before risky actions like sending, deleting, buying, changing settings, or sharing private info.

## Good Starter Prompts

- "Show me the menu."
- "Search the web for the latest AI video tools."
- "Create a chart of my workflow."
- "Add a note: follow up on the sponsor."
- "Switch to computer use mode and open Notes."`;
}

async function generateImage(args) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return imageErrorArtifact("OPENAI_API_KEY is missing in .env.local.");
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt: String(args.prompt || ""),
      size: String(args.size || "1024x1024"),
      quality: "medium",
    }),
  });

  if (!response.ok) {
    return imageErrorArtifact(`Image generation failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  const url = data.data?.[0]?.url;
  if (b64) {
    await fs.mkdir(dataDir, { recursive: true });
    const imagePath = path.join(dataDir, `jarvis-image-${Date.now()}.png`);
    await fs.writeFile(imagePath, Buffer.from(b64, "base64"));
    return {
      ok: true,
      path: imagePath,
      artifact: {
        title: "Generated Image",
        kind: "image",
        content: `data:image/png;base64,${b64}`,
      },
    };
  }
  if (url) {
    return { ok: true, url, artifact: { title: "Generated Image", kind: "image", content: url } };
  }
  return imageErrorArtifact("Image response did not include image data.");
}

function imageErrorArtifact(error) {
  return {
    ok: false,
    error,
    artifact: {
      title: "Image Generation Failed",
      kind: "markdown",
      content: `# Image generation failed\n\n${cleanMarkdownText(error)}\n\nTry a shorter prompt, a different size, or check model access for \`gpt-image-2\`.`,
    },
  };
}

async function thumbnailReferenceAdd(args) {
  const imagePath = path.resolve(String(args.imagePath || "").replace(/^file:\/\//, ""));
  try {
    await fs.access(imagePath);
  } catch {
    return imageErrorArtifact(`Reference image not found: ${imagePath}`);
  }

  const db = await readDb();
  const reference = {
    id: crypto.randomUUID(),
    path: imagePath,
    label: String(args.label || path.basename(imagePath)),
    createdAt: new Date().toISOString(),
  };
  db.thumbnailBoard.references.unshift(reference);
  await writeDb(db);
  return {
    ok: true,
    reference,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, "grid"),
    message: `Added ${reference.label} as a thumbnail reference image.`,
  };
}

async function thumbnailLoadingPrepare(args) {
  const runId = crypto.randomUUID();
  const count = 1;
  const mode = args.mode === "edit" ? "edited" : "generated";
  let target = null;
  const { db } = await updateDb(async (currentDb) => {
    target = mode === "edited" ? thumbnailByNumberOrSelected(currentDb, args.number, args.targetId) : null;
    const placeholders = Array.from({ length: count }, (_unused, index) => ({
      id: crypto.randomUUID(),
      number: currentDb.thumbnailBoard.nextNumber++,
      runId,
      status: "loading",
      type: mode,
      prompt: String(args.prompt || ""),
      size: "1536x1024",
      parentId: target?.id || null,
      createdAt: new Date().toISOString(),
      loadingLabel: count > 1 ? `Generating ${index + 1}/${count}` : mode === "edited" ? "Editing" : "Generating",
    }));

    currentDb.thumbnailBoard.images.unshift(...placeholders);
    if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
      currentDb.thumbnailBoard.selectedId = null;
      currentDb.thumbnailBoard.view = "grid";
      currentDb.thumbnailBoard.page = 1;
    }
  });
  const view = db.thumbnailBoard.view === "selected" && db.thumbnailBoard.selectedId ? "selected" : "grid";
  return {
    ok: true,
    runId,
    targetId: target?.id || null,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, view),
  };
}

async function thumbnailGenerate(args) {
  try {
    const db = await readDb();
    const prompt = thumbnailPrompt(String(args.prompt || ""), db.thumbnailBoard.references.length > 0);
    const size = "1536x1024";
    const count = 1;
    const referencePaths = db.thumbnailBoard.references.map((reference) => reference.path).slice(0, 4);

    const generated = await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const image = await createThumbnailImage({
          prompt,
          size,
          inputPaths: referencePaths,
        });
        return thumbnailRecord(image, args.prompt, "generated", size);
      }),
    );

    const { db: latestDb } = await updateDb(async (currentDb) => {
      replaceLoadingThumbnails(currentDb, args.runId, generated);
      if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
        currentDb.thumbnailBoard.selectedId = null;
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = 1;
      }
    });
    const view = latestDb.thumbnailBoard.view === "selected" && latestDb.thumbnailBoard.selectedId ? "selected" : "grid";
    return {
      ok: true,
      count: generated.length,
      board: thumbnailBoardSummary(latestDb),
      artifact: await thumbnailBoardArtifact(latestDb, view),
      silent: true,
      thumbnailReady: true,
    };
  } catch (error) {
    if (args.runId) await removeLoadingThumbnailRun(args.runId);
    return imageErrorArtifact(error instanceof Error ? error.message : String(error));
  }
}

async function thumbnailEdit(args) {
  try {
    const db = await readDb();
    const target = thumbnailByNumberOrSelected(db, args.number, args.targetId);
    if (!target) {
      return imageErrorArtifact("No thumbnail is selected. Say a number, like 'edit number two', or generate a thumbnail first.");
    }

    const size = "1536x1024";
    const count = 1;
    const referencePaths = db.thumbnailBoard.references.map((reference) => reference.path).slice(0, 3);
    const inputPaths = [target.path, ...referencePaths].filter(Boolean);
    const editPrompt = editThumbnailPrompt(String(args.prompt || ""), target.prompt || "");

    const edited = await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const image = await createThumbnailImage({
          prompt: editPrompt,
          size,
          inputPaths,
        });
        return {
          ...thumbnailRecord(image, args.prompt, "edited", size),
          parentId: target.id,
        };
      }),
    );

    const { db: latestDb } = await updateDb(async (currentDb) => {
      replaceLoadingThumbnails(currentDb, args.runId, edited);
      if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
        currentDb.thumbnailBoard.selectedId = null;
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = 1;
      }
    });
    const view = latestDb.thumbnailBoard.view === "selected" && latestDb.thumbnailBoard.selectedId ? "selected" : "grid";
    return {
      ok: true,
      count: edited.length,
      board: thumbnailBoardSummary(latestDb),
      artifact: await thumbnailBoardArtifact(latestDb, view),
      silent: true,
      thumbnailReady: true,
    };
  } catch (error) {
    if (args.runId) await removeLoadingThumbnailRun(args.runId);
    return imageErrorArtifact(error instanceof Error ? error.message : String(error));
  }
}

async function thumbnailSelect(args) {
  const db = await readDb();
  const number = Number(args.number || 0);
  const selected = db.thumbnailBoard.images.find((image) => image.number === number);
  if (!selected) {
    return imageErrorArtifact(`Thumbnail number ${number} does not exist yet.`);
  }
  if (selected.status === "loading") {
    return imageErrorArtifact(`Thumbnail number ${number} is still generating.`);
  }
  db.thumbnailBoard.selectedId = selected.id;
  db.thumbnailBoard.view = "selected";
  await writeDb(db);
  return {
    ok: true,
    selected,
    selectedNumber: number,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, "selected"),
    message: `Selected thumbnail ${number}.`,
  };
}

async function createThumbnailImage({ prompt, size, inputPaths }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing in .env.local.");
  }

  if (inputPaths.length > 0) {
    return await editImageWithInputs({ apiKey, prompt, size, inputPaths });
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      size,
      quality: "medium",
    }),
  });

  if (!response.ok) {
    throw new Error(`Thumbnail generation failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return await saveImageResponse(data, "thumbnail");
}

async function editImageWithInputs({ apiKey, prompt, size, inputPaths }) {
  const buildForm = async (imageFieldName) => {
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", "medium");
    for (const inputPath of inputPaths.slice(0, 10)) {
      const buffer = await fs.readFile(inputPath);
      form.append(imageFieldName, new Blob([buffer], { type: mimeForPath(inputPath) }), path.basename(inputPath));
    }
    return form;
  };

  let response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: await buildForm("image[]"),
  });

  if (!response.ok) {
    const firstError = await response.text();
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: await buildForm("image"),
    });
    if (!response.ok) {
      throw new Error(`Thumbnail edit failed: ${response.status} ${await response.text() || firstError}`);
    }
  }

  const data = await response.json();
  return await saveImageResponse(data, "thumbnail");
}

async function saveImageResponse(data, prefix) {
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Image response did not include image data.");
  }
  await fs.mkdir(dataDir, { recursive: true });
  const imagePath = path.join(dataDir, `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`);
  await fs.writeFile(imagePath, Buffer.from(b64, "base64"));
  return { path: imagePath, dataUrl: `data:image/png;base64,${b64}` };
}

function thumbnailRecord(image, prompt, type, size) {
  return {
    id: crypto.randomUUID(),
    type,
    path: image.path,
    prompt: String(prompt || ""),
    size,
    createdAt: new Date().toISOString(),
  };
}

function thumbnailPrompt(prompt, hasReferences) {
  return [
    hasReferences ? "Use the provided reference image(s) of Luis as the identity reference." : "",
    "Create one 16:9 YouTube thumbnail.",
    "Follow this request literally. Do not add extra concepts, fake UI, extra text, watermarks, or unrelated elements.",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function editThumbnailPrompt(prompt, originalPrompt) {
  return [
    "Edit the provided thumbnail image.",
    "Make only this change. Preserve everything else unless the request says otherwise.",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function thumbnailByNumberOrSelected(db, number, targetId) {
  const candidate = targetId
    ? db.thumbnailBoard.images.find((image) => image.id === targetId) || null
    : number
      ? db.thumbnailBoard.images.find((image) => image.number === Number(number)) || null
      : db.thumbnailBoard.selectedId
        ? db.thumbnailBoard.images.find((image) => image.id === db.thumbnailBoard.selectedId) || null
        : null;
  if (candidate?.status === "loading") return null;
  return candidate;
}

function replaceLoadingThumbnails(db, runId, records) {
  if (!runId) {
    db.thumbnailBoard.images.unshift(...records.map((record) => assignThumbnailNumber(db, record)));
    return;
  }

  const placeholders = db.thumbnailBoard.images
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => image.runId === runId && image.status === "loading");

  if (placeholders.length === 0) {
    db.thumbnailBoard.images.unshift(...records.map((record) => assignThumbnailNumber(db, record)));
    return;
  }

  for (const [recordIndex, placeholder] of placeholders.entries()) {
    const replacement = records[recordIndex];
    if (replacement) db.thumbnailBoard.images[placeholder.index] = { ...replacement, number: placeholder.image.number };
  }

  if (records.length > placeholders.length) {
    db.thumbnailBoard.images.unshift(...records.slice(placeholders.length).map((record) => assignThumbnailNumber(db, record)));
  }
}

async function removeLoadingThumbnailRun(runId) {
  await updateDb(async (db) => {
    db.thumbnailBoard.images = db.thumbnailBoard.images.filter(
      (image) => !(image.runId === runId && image.status === "loading"),
    );
    db.thumbnailBoard.view = "grid";
    if (db.thumbnailBoard.selectedId && !db.thumbnailBoard.images.some((image) => image.id === db.thumbnailBoard.selectedId)) {
      db.thumbnailBoard.selectedId = null;
    }
  });
}

function thumbnailNumber(db, id) {
  return db.thumbnailBoard.images.find((image) => image.id === id)?.number || null;
}

function assignThumbnailNumber(db, image) {
  if (Number.isInteger(image.number) && image.number > 0) return image;
  return { ...image, number: db.thumbnailBoard.nextNumber++ };
}

function pageForArgs(args) {
  const page = Number(args?.page || 1);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function sortedThumbnailImages(db) {
  return [...db.thumbnailBoard.images].sort((a, b) => (b.number || 0) - (a.number || 0));
}

function paginatedThumbnailImages(db, page = db.thumbnailBoard.page || 1) {
  const pageSize = db.thumbnailBoard.pageSize || 9;
  const start = (page - 1) * pageSize;
  return sortedThumbnailImages(db).slice(start, start + pageSize);
}

function thumbnailPageMeta(db) {
  const pageSize = db.thumbnailBoard.pageSize || 9;
  const totalImages = db.thumbnailBoard.images.length;
  return {
    page: db.thumbnailBoard.page || 1,
    pageSize,
    totalImages,
    totalPages: Math.max(1, Math.ceil(totalImages / pageSize)),
    nextNumber: db.thumbnailBoard.nextNumber,
  };
}

function thumbnailBoardSummary(db) {
  const board = db.thumbnailBoard;
  const selectedNumber = board.selectedId ? thumbnailNumber(db, board.selectedId) : null;
  const page = thumbnailPageMeta(db);
  return {
    view: board.view,
    selectedNumber,
    references: board.references.length,
    page,
    images: paginatedThumbnailImages(db, page.page).map((image) => ({
      number: image.number,
      id: image.id,
      status: image.status === "loading" ? "loading" : "ready",
      type: image.type || "thumbnail",
      prompt: image.prompt || "",
    })),
  };
}

function buildThumbnailBoardInstructions(db) {
  const summary = thumbnailBoardSummary(db);
  const imageLines = summary.images.length
    ? summary.images
        .map((image) => `- #${image.number}: ${image.status}${image.status === "ready" ? `, ${image.type}` : ""}${image.prompt ? `, prompt: ${image.prompt.slice(0, 120)}` : ""}`)
        .join("\n")
    : "- No generated thumbnails yet.";

  return `# Current Thumbnail Board State
Reference images loaded: ${summary.references}
Current view: ${summary.view}
Selected thumbnail number: ${summary.selectedNumber || "none"}
Current page: ${summary.page.page}/${summary.page.totalPages}
Total thumbnails: ${summary.page.totalImages}
Next new thumbnail number: ${summary.page.nextNumber}
Visible permanent thumbnail numbers:
${imageLines}

When Luis says "pull up number N", "select N", or "show N", call thumbnail_select with that permanent number. When Luis says "edit this", use thumbnail_edit with no number if a selected thumbnail number exists. When Luis says "edit number N", call thumbnail_edit with that permanent number. When Luis asks for older thumbnails or another page, call thumbnail_grid with the requested page. Do not claim you cannot see prior thumbnails; this board state is persistent and paginated.`;
}

async function thumbnailBoardArtifact(db, view) {
  const board = db.thumbnailBoard;
  const selected = board.images.find((image) => image.id === board.selectedId) || null;
  const page = thumbnailPageMeta(db);
  const visibleImages = view === "selected" && selected ? [selected] : paginatedThumbnailImages(db, page.page);
  const images = await Promise.all(
    visibleImages.map(async (image) => {
      const src = image.path ? await imageDataUrl(image.path) : null;
      return {
        ...image,
        number: image.number,
        src,
        selected: selected?.id === image.id,
      };
    }),
  );

  return {
    title: view === "selected" && selected ? `Thumbnail ${thumbnailNumber(db, selected.id)}` : "Thumbnail Board",
    kind: "thumbnailBoard",
    fullscreen: view === "selected",
    content: JSON.stringify({
      view,
      selectedId: board.selectedId,
      references: board.references,
      page,
      images,
    }),
  };
}

async function imageDataUrl(imagePath) {
  const buffer = await fs.readFile(imagePath);
  return `data:${mimeForPath(imagePath)};base64,${buffer.toString("base64")}`;
}

function mimeForPath(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function recordsArtifact(records, collection) {
  return {
    title: `Records: ${collection}`,
    kind: "table",
    content: JSON.stringify(records, null, 2),
  };
}

function normalizeMermaidDiagram(diagram, title) {
  const stripped = diagram
    .replace(/```mermaid/gi, "")
    .replace(/```/g, "")
    .replace(/\r/g, "")
    .trim();

  if (!stripped) {
    return fallbackMermaidDiagram(title);
  }

  const lines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[–—]/g, "-")
        .replace(/\s+-->\s+/g, " --> ")
        .replace(/\s+---\s+/g, " --- "),
    );

  const hasDiagramHeader = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline)\b/i.test(
    lines[0] || "",
  );

  return hasDiagramHeader ? lines.join("\n") : `flowchart TD\n${lines.join("\n")}`;
}

function fallbackMermaidDiagram(title) {
  const safeTitle = String(title || "Chart").replace(/["<>]/g, "");
  return `flowchart TD\n  A["${safeTitle}"] --> B["Chart request received"]\n  B --> C["Jarvis will show a safe fallback if syntax fails"]`;
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
