# RileyJarvis

RileyJarvis is a local Electron desktop AI companion with realtime voice, a visual artifact panel, image generation, web search, notes, and opt-in computer control on macOS and Windows.

It is built with Electron, React, Vite, TypeScript, and the OpenAI Realtime API.

## Features

- Realtime speech-to-speech conversation with OpenAI Realtime.
- Animated companion face with listening, thinking, speaking, and working states.
- Artifact panel for markdown, menus, notes, Mermaid diagrams, generated images, records, and progress.
- YouTube thumbnail board with persistent numbered generations and image edits.
- Optional Exa-powered web search.
- Local notes and records stored at runtime under `data/`.
- Optional computer-use mode for opening apps, clicking, typing, scrolling, screenshots, and UI inspection on macOS and Windows.

## Requirements

- macOS or Windows 10/11
- Node.js 20+
- npm
- An OpenAI API key with Realtime and image generation access
- Optional: an Exa API key for web search

## Quick Start

```bash
git clone https://github.com/rileybrown/rileyjarvis.git
cd rileyjarvis
npm install
cp .env.example .env.local
npm run dev
```

Edit `.env.local` before starting voice features:

```bash
OPENAI_API_KEY=your_openai_api_key_here
EXA_API_KEY=your_exa_api_key_here
```

`OPENAI_API_KEY` is required. `EXA_API_KEY` is optional; web search will show a setup message when it is missing.

## macOS Permissions

RileyJarvis runs locally. Depending on the features you use, macOS may ask for:

- Microphone permission for voice conversation.
- Accessibility permission for computer-control tools.
- Screen Recording permission for screenshots and screen inspection.

## Windows Notes

On Windows, computer-control tools use PowerShell with Win32 input (`SendInput`) and UI Automation, and screenshots use Electron's `desktopCapturer`. No extra permissions are needed, but Windows blocks input into apps running as administrator unless RileyJarvis is also elevated. Click coordinates are physical pixels on the primary display, matching `screen_snapshot` images.

Computer-control tools are blocked until the app is in computer-use mode.

## Development

```bash
npm run dev
```

This starts Vite on `127.0.0.1:5173` and launches Electron.

Other useful commands:

```bash
npm run typecheck
npm run build
npm start
```

## Runtime Data

The app creates a local `data/` directory for notes, records, generated images, and thumbnail-board state. That directory is intentionally ignored by Git.

Do not commit:

- `.env.local`
- Anything under `data/`
- `dist/`
- `node_modules/`

## Security Notes

- API keys are loaded only from local environment files.
- `.env.local` and all `.env.*` files are ignored except `.env.example`.
- Generated images and local database files are ignored.
- Risky computer-control actions should require explicit confirmation.
- Typing and pressing Enter in computer-use mode are intentionally allowed without extra confirmation because they are core voice-control actions.

Before publishing a fork, run:

```bash
npm run typecheck
npm run build
git status --short
```

Then verify that no local secrets or runtime data are staged.

## License

MIT
