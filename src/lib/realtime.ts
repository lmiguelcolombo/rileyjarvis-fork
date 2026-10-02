import type { JarvisArtifact, JarvisToolCall, JarvisToolResult, JarvisToolSpec } from "../vite-env";

export type JarvisConnectionState = "idle" | "connecting" | "connected" | "error";
export type JarvisMood = "idle" | "listening" | "thinking" | "speaking" | "working" | "error";

export type MouthShape = {
  open: number;
  width: number;
  round: number;
  teeth: number;
};

export type TranscriptEntry = {
  id: string;
  role: "user" | "jarvis" | "system" | "tool";
  text: string;
  at: string;
};

export type RealtimeCallbacks = {
  onConnectionState: (state: JarvisConnectionState) => void;
  onMood: (mood: JarvisMood) => void;
  onMouthShape: (shape: MouthShape) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onArtifact: (artifact: JarvisArtifact) => void;
  onMode: (mode: "display" | "computer") => void;
  onStatus: (message: string) => void;
  onThumbnailReady: () => void;
};

type ServerEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  response?: {
    output?: ResponseOutputItem[];
  };
  item?: {
    type?: string;
    role?: string;
    content?: Array<{ transcript?: string; text?: string }>;
  };
  error?: {
    message?: string;
  };
};

type ResponseOutputItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{ transcript?: string; text?: string }>;
};

const realtimeUrl = "https://api.openai.com/v1/realtime/calls";

export class JarvisRealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private callbacks: RealtimeCallbacks;
  private currentAssistantText = "";
  private toolSpecs: JarvisToolSpec[] = [];
  private toolRunning = false;
  // Realtime rejects response.create while a response is in progress, which happens when Luis speaks
  // (server VAD starts a response) while a tool is still running. Requests made then wait for response.done.
  private responseActive = false;
  private responsePending = false;
  private audioContext: AudioContext | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private outputMeterFrame = 0;
  private smoothedMouthShape: MouthShape = silentMouthShape();

  constructor(callbacks: RealtimeCallbacks) {
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    if (this.pc) return;
    this.callbacks.onConnectionState("connecting");
    this.callbacks.onMood("thinking");
    this.callbacks.onStatus("Minting a Realtime client secret.");

    try {
      this.toolSpecs = await window.jarvis.getToolSpecs();
      const token = await window.jarvis.createRealtimeToken();
      const pc = new RTCPeerConnection();
      const audio = document.createElement("audio");
      audio.autoplay = true;

      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        this.startOutputMeter(event.streams[0]);
      };

      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      pc.addTrack(this.micStream.getAudioTracks()[0], this.micStream);

      const dc = pc.createDataChannel("oai-events");
      dc.addEventListener("open", () => {
        this.callbacks.onConnectionState("connected");
        this.callbacks.onMood("idle");
        this.callbacks.onStatus("Jarvis is live. Start talking naturally.");
      });
      dc.addEventListener("message", (event) => {
        void this.handleServerEvent(event.data);
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(realtimeUrl, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!sdpResponse.ok) {
        throw new Error(`Realtime WebRTC call failed: ${sdpResponse.status} ${await sdpResponse.text()}`);
      }

      await pc.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text(),
      });

      this.pc = pc;
      this.dc = dc;
    } catch (error) {
      this.callbacks.onConnectionState("error");
      this.callbacks.onMood("error");
      this.callbacks.onStatus(error instanceof Error ? error.message : String(error));
      this.disconnect();
    }
  }

  disconnect(): void {
    this.dc?.close();
    this.pc?.close();
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.stopOutputMeter();
    this.dc = null;
    this.pc = null;
    this.micStream = null;
    this.currentAssistantText = "";
    this.responseActive = false;
    this.responsePending = false;
    this.callbacks.onConnectionState("idle");
    this.callbacks.onMood("idle");
    this.callbacks.onMouthShape(silentMouthShape());
  }

  sendText(text: string): void {
    if (!this.dc || this.dc.readyState !== "open") {
      this.callbacks.onStatus("Connect Jarvis before sending a text prompt.");
      return;
    }
    this.callbacks.onTranscript(newEntry("user", text));
    debugLog({ kind: "user_text", text });
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.requestResponse();
  }

  private async handleServerEvent(raw: string): Promise<void> {
    const event = safeParseEvent(raw);
    if (!event.type) return;

    if (event.type === "response.created") {
      this.responseActive = true;
      return;
    }

    if (event.type === "error") {
      // A failed response.create never produces response.done, so don't stay blocked on it.
      this.responseActive = false;
      debugLog({ kind: "error", message: event.error?.message });
      this.callbacks.onMood("error");
      this.callbacks.onStatus(event.error?.message || "Realtime API returned an error.");
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      this.callbacks.onMood("listening");
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      this.callbacks.onMood("thinking");
      return;
    }

    if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
      this.callbacks.onMood("speaking");
      return;
    }

    if (event.type === "response.output_audio.done" || event.type === "response.audio.done") {
      if (!this.toolRunning) this.callbacks.onMood("idle");
      return;
    }

    if (
      event.type === "response.audio_transcript.delta" ||
      event.type === "response.output_audio_transcript.delta" ||
      event.type === "response.output_text.delta"
    ) {
      this.currentAssistantText += event.delta || "";
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = event.transcript || collectItemText(event.item);
      if (transcript) {
        this.callbacks.onTranscript(newEntry("user", transcript));
        debugLog({ kind: "user_speech", text: transcript });
      }
      return;
    }

    if (event.type === "response.done") {
      this.responseActive = false;
      if (this.responsePending) {
        this.responsePending = false;
        this.requestResponse();
      }
      const output = event.response?.output || [];
      const spoken = this.currentAssistantText || output.map(collectOutputText).filter(Boolean).join("\n");
      if (spoken) {
        this.callbacks.onTranscript(newEntry("jarvis", spoken));
        debugLog({ kind: "jarvis", text: spoken });
      }
      this.currentAssistantText = "";

      const functionCalls = output.filter((item) => item.type === "function_call" && item.name && item.call_id);
      if (functionCalls.length > 0) {
        await this.executeFunctionCalls(functionCalls);
      } else if (!this.toolRunning) {
        this.callbacks.onMood("idle");
      }
    }
  }

  private async executeFunctionCalls(items: ResponseOutputItem[]): Promise<void> {
    this.toolRunning = true;
    this.callbacks.onMood("working");
    let shouldCreateResponse = false;

    for (const item of items) {
      const callId = item.call_id;
      const name = item.name;
      if (!callId || !name) continue;

      const parsedArgs = parseToolArguments(item.arguments || "{}");
      const knownTool = this.toolSpecs.some((tool) => tool.name === name);
      if (!knownTool) {
        await this.returnToolOutput(callId, {
          ok: false,
          error: `Tool is not available: ${name}`,
        });
        shouldCreateResponse = true;
        continue;
      }

      this.callbacks.onTranscript(newEntry("tool", `Running ${name}`));
      debugLog({ kind: "tool_call", name, arguments: parsedArgs });
      if (name === "image_generate") {
        this.callbacks.onArtifact({
          title: "Generating Image",
          kind: "imageLoading",
          content: typeof parsedArgs.prompt === "string" ? parsedArgs.prompt : "Jarvis is generating an image.",
        });
      }
      if (name === "thumbnail_generate" || name === "thumbnail_edit") {
        const loadingResult = await window.jarvis.executeTool({
          name: "thumbnail_loading_prepare",
          arguments: {
            ...parsedArgs,
            mode: name === "thumbnail_edit" ? "edit" : "generate",
          },
        } satisfies JarvisToolCall);
        if (typeof loadingResult.runId === "string") parsedArgs.runId = loadingResult.runId;
        if (typeof loadingResult.targetId === "string") parsedArgs.targetId = loadingResult.targetId;
        if (loadingResult.artifact) this.callbacks.onArtifact(loadingResult.artifact);
      }
      const result = await window.jarvis.executeTool({ name, arguments: parsedArgs } satisfies JarvisToolCall);
      if (result.mode === "display" || result.mode === "computer") {
        this.callbacks.onMode(result.mode);
      }
      if (result.artifact) this.callbacks.onArtifact(result.artifact);
      if (result.thumbnailReady === true) this.callbacks.onThumbnailReady();
      if (result.silent !== true) shouldCreateResponse = true;
      await this.returnToolOutput(callId, result);
      debugLog({ kind: "tool_result", name, result: truncate(JSON.stringify(sanitizeToolResult(result)), 4000) });
      if (typeof result.modelImage === "string") this.sendImage(result.modelImage);
    }

    if (shouldCreateResponse) this.requestResponse();
    this.toolRunning = false;
  }

  private async returnToolOutput(callId: string, result: JarvisToolResult): Promise<void> {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(sanitizeToolResult(result)),
      },
    });
  }

  private requestResponse(): void {
    if (this.responseActive) {
      this.responsePending = true;
      return;
    }
    // Marked active on send, not on response.created, so two requests in a row can't both go out.
    if (this.sendEvent({ type: "response.create" })) this.responseActive = true;
  }

  // Screenshots go in as a user image item so the model can actually see the screen.
  private sendImage(dataUrl: string): void {
    const sent = this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: dataUrl }],
      },
    });
    if (!sent) {
      this.callbacks.onStatus("Screenshot was too large to send to Jarvis.");
      this.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "The screenshot could not be attached. Do not click based on it." }],
        },
      });
    }
  }

  private sendEvent(event: Record<string, unknown>): boolean {
    if (this.dc?.readyState !== "open") return false;
    const payload = JSON.stringify(event);
    const maxMessageSize = this.pc?.sctp?.maxMessageSize;
    if (maxMessageSize && payload.length > maxMessageSize) return false;
    this.dc.send(payload);
    return true;
  }

  private startOutputMeter(stream: MediaStream): void {
    this.stopOutputMeter();

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);

    this.audioContext = audioContext;
    this.outputAnalyser = analyser;

    const samples = new Uint8Array(analyser.fftSize);
    const frequencies = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      analyser.getByteFrequencyData(frequencies);
      let total = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        total += centered * centered;
      }
      const rms = Math.sqrt(total / samples.length);
      const energy = clamp01(rms * 10.5);
      const bands = getSpeechBands(frequencies);

      // Simple realtime viseme approximation: low energy rounds the mouth,
      // mid energy opens it, high energy stretches it for consonants/ee sounds.
      const target: MouthShape = {
        open: clamp01(energy * 0.75 + bands.mid * 0.45 - bands.high * 0.16),
        width: clamp01(0.28 + bands.mid * 0.55 + bands.high * 0.74 - bands.low * 0.28),
        round: clamp01(0.08 + bands.low * 0.95 + energy * 0.1 - bands.high * 0.42),
        teeth: clamp01(bands.high * 1.4 + bands.mid * 0.25 - bands.low * 0.35),
      };

      this.smoothedMouthShape = smoothMouthShape(this.smoothedMouthShape, target, 0.36);
      this.callbacks.onMouthShape(this.smoothedMouthShape);
      this.outputMeterFrame = window.requestAnimationFrame(tick);
    };
    tick();
  }

  private stopOutputMeter(): void {
    if (this.outputMeterFrame) {
      window.cancelAnimationFrame(this.outputMeterFrame);
      this.outputMeterFrame = 0;
    }
    void this.audioContext?.close();
    this.audioContext = null;
    this.outputAnalyser = null;
    this.smoothedMouthShape = silentMouthShape();
  }
}

function silentMouthShape(): MouthShape {
  return { open: 0, width: 0.18, round: 0, teeth: 0 };
}

function smoothMouthShape(current: MouthShape, target: MouthShape, amount: number): MouthShape {
  return {
    open: lerp(current.open, target.open, amount),
    width: lerp(current.width, target.width, amount),
    round: lerp(current.round, target.round, amount),
    teeth: lerp(current.teeth, target.teeth, amount),
  };
}

function getSpeechBands(frequencies: Uint8Array): { low: number; mid: number; high: number } {
  const low = averageRange(frequencies, 2, 14) / 255;
  const mid = averageRange(frequencies, 14, 48) / 255;
  const high = averageRange(frequencies, 48, 110) / 255;
  return { low: clamp01(low * 2.2), mid: clamp01(mid * 2.1), high: clamp01(high * 2.8) };
}

function averageRange(values: Uint8Array, start: number, end: number): number {
  const cappedEnd = Math.min(end, values.length);
  if (start >= cappedEnd) return 0;
  let total = 0;
  for (let index = start; index < cappedEnd; index += 1) {
    total += values[index];
  }
  return total / (cappedEnd - start);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function newEntry(role: TranscriptEntry["role"], text: string): TranscriptEntry {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    at: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  };
}

// Sends a line to the main process's validation log; a no-op there unless JARVIS_DEBUG_LOG=1.
function debugLog(entry: Record<string, unknown>): void {
  window.jarvis.log(entry);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function safeParseEvent(raw: string): ServerEvent {
  try {
    return JSON.parse(raw) as ServerEvent;
  } catch {
    return {};
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sanitizeToolResult(result: JarvisToolResult): JarvisToolResult {
  const { modelImage: _modelImage, ...withoutImage } = result;
  if (!withoutImage.artifact) return withoutImage;

  const { artifact, ...rest } = withoutImage;
  return {
    ...rest,
    artifact: {
      title: artifact.title,
      kind: artifact.kind,
      content:
        artifact.kind === "thumbnailBoard"
          ? "Thumbnail board rendered in the UI. Use the compact board field for exact numbers, selected state, and loading state."
          : artifact.kind === "image" || artifact.kind === "imageLoading"
            ? "Image rendered in the UI."
            : artifact.content.length > 1200
              ? `${artifact.content.slice(0, 1200)}...`
              : artifact.content,
      language: artifact.language,
      fullscreen: artifact.fullscreen,
    },
  };
}

function collectItemText(item: ServerEvent["item"]): string {
  return item?.content?.map((part) => part.transcript || part.text || "").filter(Boolean).join("\n") || "";
}

function collectOutputText(item: ResponseOutputItem): string {
  return item.content?.map((part) => part.transcript || part.text || "").filter(Boolean).join("\n") || "";
}
