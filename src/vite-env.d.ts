/// <reference types="vite/client" />

export type JarvisArtifact = {
  title: string;
  kind:
    | "text"
    | "markdown"
    | "code"
    | "table"
    | "notes"
    | "mermaid"
    | "image"
    | "imageLoading"
    | "thumbnailBoard"
    | "progress";
  content: string;
  language?: string;
  fullscreen?: boolean;
};

export type JarvisToolSpec = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type JarvisToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type JarvisToolResult = {
  ok: boolean;
  artifact?: JarvisArtifact;
  mode?: "display" | "computer";
  message?: string;
  error?: string;
  [key: string]: unknown;
};

declare global {
  interface Window {
    jarvis: {
      createRealtimeToken: () => Promise<{ value: string; expiresAt: number | null }>;
      executeTool: (toolCall: JarvisToolCall) => Promise<JarvisToolResult>;
      getToolSpecs: () => Promise<JarvisToolSpec[]>;
      log: (entry: Record<string, unknown>) => void;
    };
  }
}
