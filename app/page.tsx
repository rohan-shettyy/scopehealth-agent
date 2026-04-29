"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type MessageRole = "system" | "assistant" | "user" | "tool";

interface TranscriptMessage {
  id: number;
  role: MessageRole;
  content: string;
  sequence: number;
  createdAt: string;
}

interface SessionState {
  channel: "call" | "sms";
  status: "active" | "ended" | "completed";
  identityVerified: boolean;
  nextExpectedStep: string;
  lastCompletedStep?: string;
  selectedMedication?: {
    medicationName: string;
    strength: string;
  };
  selectedPharmacy?: {
    name: string;
    addressLine1?: string;
    isAlternate?: boolean;
  };
  insuranceVerified: boolean;
  copayAmountCents?: number;
}

interface SessionSnapshot {
  id: number;
  sessionKey: string;
  state: SessionState;
}

interface TranscriptResponse {
  session: SessionSnapshot;
  messages: TranscriptMessage[];
  refillRequest?: {
    id: number;
    status: string;
  };
  voiceEvents?: VoiceEvent[];
}

interface VoiceEvent {
  type: string;
  provider: string;
  text?: string;
  audioBase64?: string;
  mimeType?: string;
}

interface TurnResponse {
  session: SessionSnapshot;
  agentReply: string;
  isComplete: boolean;
  refillRequest?: {
    id: number;
    status: string;
  };
  voiceEvents?: VoiceEvent[];
}

type CallStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "listening"
  | "processing"
  | "speaking"
  | "thinking"
  | "ended";

export default function Home() {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [refillRequest, setRefillRequest] =
    useState<TranscriptResponse["refillRequest"]>();
  const [input, setInput] = useState("");
  const [smsInput, setSmsInput] = useState("");
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [audioNotice, setAudioNotice] = useState("Microphone idle");
  const [error, setError] = useState<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const activeSessionIdRef = useRef<number | null>(null);
  const mutedRef = useRef(false);
  const processingAudioRef = useRef(false);
  const audioPostInFlightRef = useRef(false);
  const agentSpeakingRef = useRef(false);
  const hasSpeechRef = useRef(false);
  const silenceStartedAtRef = useRef<number | null>(null);
  const utteranceStartedAtRef = useRef<number | null>(null);
  const utteranceChunksRef = useRef<Int16Array[]>([]);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playbackResolveRef = useRef<(() => void) | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);

  const isBusy =
    callStatus === "connecting" ||
    callStatus === "thinking" ||
    callStatus === "processing" ||
    callStatus === "speaking";
  const canSend =
    session?.state.channel === "call" &&
    session.state.status === "active" &&
    !isBusy;
  const canSendSms =
    session?.state.channel === "sms" &&
    session.state.status === "active" &&
    !isBusy;
  const smsMessages = useMemo(
    () => getSmsThreadMessages(messages, session?.state.channel === "sms"),
    [messages, session?.state.channel]
  );

  const workflowSummary = useMemo(() => {
    if (!session) {
      return "Start a simulated call to begin.";
    }

    const state = session.state;
    const details = [
      state.selectedMedication
        ? `${state.selectedMedication.medicationName} ${state.selectedMedication.strength}`
        : undefined,
      state.selectedPharmacy
        ? state.selectedPharmacy.addressLine1
          ? `${state.selectedPharmacy.name}, ${state.selectedPharmacy.addressLine1}`
          : state.selectedPharmacy.name
        : undefined,
      state.copayAmountCents !== undefined
        ? `$${(state.copayAmountCents / 100).toFixed(2).replace(/\.00$/, "")}`
        : undefined
    ].filter(Boolean);

    return details.length > 0 ? details.join(" • ") : "No refill details collected yet.";
  }, [session]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, callStatus]);

  useEffect(() => {
    if (!session || session.state.status !== "active") {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshSession(session.id, { quiet: true });
    }, 2500);

    return () => window.clearInterval(interval);
  }, [session?.id, session?.state.status]);

  useEffect(() => {
    mutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    return () => {
      void stopAudioCapture();
    };
  }, []);

  async function startCall() {
    setError(null);
    setCallStatus("connecting");

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const data = await postJson<TranscriptResponse>("/api/workflow/call/start");
      applyTranscript(data);
      await startAudioCapture(data.session.id, mediaStream);
      await playModelAudio(data.voiceEvents ?? []);
      setCallStatus("listening");
      setAudioNotice("Listening for patient speech");
    } catch (caughtError) {
      await stopAudioCapture();
      setCallStatus("idle");
      setError(formatError(caughtError));
    }
  }

  async function submitTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session || !input.trim()) {
      return;
    }

    setError(null);
    setCallStatus("thinking");

    try {
      const data = await postJson<TurnResponse>("/api/workflow/call/input", {
        sessionId: session.id,
        text: input.trim()
      });
      setInput("");
      setSession(data.session);
      setRefillRequest(data.refillRequest);
      await refreshSession(data.session.id, { quiet: true });
      await playModelAudio(data.voiceEvents ?? []);
      setCallStatus(data.session.state.status === "completed" ? "ended" : "connected");
    } catch (caughtError) {
      setCallStatus("connected");
      setError(formatError(caughtError));
    }
  }

  async function hangUp() {
    if (!session) {
      return;
    }

    const sessionId = session.id;
    setError(null);
    setCallStatus("thinking");
    setAudioNotice("Disconnecting call");

    try {
      await stopAudioCapture();
      const data = await postJson<TranscriptResponse>("/api/workflow/call/hangup", {
        sessionId
      });
      applyTranscript(data);
      setCallStatus("ended");
      setAudioNotice("Call ended; SMS fallback active");
    } catch (caughtError) {
      setCallStatus("ended");
      setError(formatError(caughtError));
    }
  }

  async function submitSms(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session || !smsInput.trim()) {
      return;
    }

    setError(null);

    try {
      const data = await postJson<TurnResponse>("/api/workflow/sms/reply", {
        sessionId: session.id,
        text: smsInput.trim()
      });
      setSmsInput("");
      setSession(data.session);
      setRefillRequest(data.refillRequest);
      await refreshSession(data.session.id, { quiet: true });
    } catch (caughtError) {
      setError(formatError(caughtError));
    }
  }

  async function refreshSession(
    sessionId: number,
    options: { quiet?: boolean } = {}
  ) {
    try {
      const response = await fetch(`/api/workflow/sessions/${sessionId}`);
      const data = (await response.json()) as TranscriptResponse | { error: string };

      if (!response.ok) {
        throw new Error("error" in data ? data.error : "Unable to fetch session");
      }

      applyTranscript(data as TranscriptResponse);
    } catch (caughtError) {
      if (!options.quiet) {
        setError(formatError(caughtError));
      }
    }
  }

  function applyTranscript(data: TranscriptResponse) {
    setSession(data.session);
    setMessages(data.messages);
    setRefillRequest(data.refillRequest);

    if (data.session.state.status === "completed") {
      setCallStatus("ended");
    }
  }

  async function startAudioCapture(sessionId: number, mediaStream: MediaStream) {
    await stopAudioCapture();

    const audioContext = new AudioContext({ sampleRate: 16000 });

    // Load the AudioWorklet module
    await audioContext.audioWorklet.addModule("/pcm-capture-processor.js");

    const source = audioContext.createMediaStreamSource(mediaStream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");

    activeSessionIdRef.current = sessionId;
    audioContextRef.current = audioContext;
    mediaStreamRef.current = mediaStream;
    sourceRef.current = source;
    workletNodeRef.current = workletNode;
    processingAudioRef.current = false;
    audioPostInFlightRef.current = false;
    hasSpeechRef.current = false;
    silenceStartedAtRef.current = null;

    workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (
        !activeSessionIdRef.current ||
        mutedRef.current ||
        audioPostInFlightRef.current ||
        (processingAudioRef.current && !agentSpeakingRef.current)
      ) {
        return;
      }

      const inputBuffer = event.data;
      const rms = getRms(inputBuffer);
      const now = Date.now();
      const speechDetected = rms > (agentSpeakingRef.current ? 0.035 : 0.018);

      if (speechDetected) {
        if (agentSpeakingRef.current) {
          interruptAgentPlayback();
        }

        hasSpeechRef.current = true;
        utteranceStartedAtRef.current ??= now;
        silenceStartedAtRef.current = null;
        setCallStatus("listening");
        setAudioNotice("Listening: speech detected");
      } else if (hasSpeechRef.current) {
        silenceStartedAtRef.current ??= now;

        if (
          now - silenceStartedAtRef.current > 900 ||
          (utteranceStartedAtRef.current !== null &&
            now - utteranceStartedAtRef.current > 12000)
        ) {
          void finishAudioTurn();
          return;
        }
      }

      if (hasSpeechRef.current) {
        const pcm = convertFloat32ToPcm16(
          inputBuffer,
          audioContext.sampleRate,
          16000
        );

        if (pcm.length > 0) {
          utteranceChunksRef.current.push(pcm);
        }
      }
    };

    source.connect(workletNode);
    // Connect to destination so the worklet stays alive
    workletNode.connect(audioContext.destination);
  }

  async function finishAudioTurn() {
    const sessionId = activeSessionIdRef.current;

    const audioChunks = utteranceChunksRef.current;

    if (
      !sessionId ||
      processingAudioRef.current ||
      !hasSpeechRef.current ||
      audioChunks.length === 0
    ) {
      return;
    }

    processingAudioRef.current = true;
    audioPostInFlightRef.current = true;
    hasSpeechRef.current = false;
    silenceStartedAtRef.current = null;
    utteranceStartedAtRef.current = null;
    utteranceChunksRef.current = [];
    setCallStatus("processing");
    setAudioNotice("Processing speech");

    try {
      const audioData = await postJson<{ voiceEvents?: VoiceEvent[] }>(
        "/api/workflow/call/audio",
        {
          sessionId,
          audioBase64: int16ToBase64(concatInt16(audioChunks)),
          mimeType: "audio/pcm;rate=16000"
        }
      );
      const providerError = audioData.voiceEvents?.find(
        (event) => event.type === "error"
      );

      if (providerError?.text) {
        throw new Error(providerError.text);
      }

      const data = await postJson<TurnResponse>("/api/workflow/call/audio/end", {
        sessionId
      });

      setSession(data.session);
      setRefillRequest(data.refillRequest);
      await refreshSession(data.session.id, { quiet: true });
      await playModelAudio(data.voiceEvents ?? []);
      setCallStatus(data.session.state.status === "completed" ? "ended" : "listening");
      setAudioNotice(
        data.session.state.status === "completed"
          ? "Workflow completed"
          : "Listening for patient speech"
      );
    } catch (caughtError) {
      setCallStatus("listening");
      setAudioNotice("Listening for patient speech");
      setError(formatError(caughtError));
    } finally {
      processingAudioRef.current = false;
      audioPostInFlightRef.current = false;
    }
  }

  async function stopAudioCapture() {
    processingAudioRef.current = false;
    audioPostInFlightRef.current = false;
    agentSpeakingRef.current = false;
    activeSessionIdRef.current = null;
    hasSpeechRef.current = false;
    silenceStartedAtRef.current = null;
    utteranceStartedAtRef.current = null;
    utteranceChunksRef.current = [];
    interruptAgentPlayback();

    workletNodeRef.current?.disconnect();
    sourceRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());

    if (audioContextRef.current?.state !== "closed") {
      await audioContextRef.current?.close();
    }

    workletNodeRef.current = null;
    sourceRef.current = null;
    mediaStreamRef.current = null;
    audioContextRef.current = null;
  }

  async function playModelAudio(events: VoiceEvent[]) {
    const audioEvents = events.filter(
      (event) => event.type === "model_audio" && event.audioBase64
    );

    if (audioEvents.length === 0) {
      return;
    }

    // Use a dedicated playback AudioContext at the system default rate
    // so 24kHz Gemini audio is resampled correctly (capture context is 16kHz).
    if (!playbackContextRef.current || playbackContextRef.current.state === "closed") {
      playbackContextRef.current = new AudioContext();
    }
    const playbackContext = playbackContextRef.current;

    // Ensure AudioContext is resumed (browser autoplay policy)
    if (playbackContext.state === "suspended") {
      await playbackContext.resume();
    }

    let startTime = Math.max(playbackContext.currentTime, playbackContext.currentTime + 0.05);

    agentSpeakingRef.current = true;
    hasSpeechRef.current = false;
    silenceStartedAtRef.current = null;
    setCallStatus("speaking");
    setAudioNotice("Agent speaking");

    try {
      for (const event of audioEvents) {
        const sampleRate = getPcmRate(event.mimeType) ?? 24000;
        const samples = base64ToInt16(event.audioBase64 ?? "");
        const audioBuffer = playbackContext.createBuffer(
          1,
          samples.length,
          sampleRate
        );
        const channelData = audioBuffer.getChannelData(0);

        for (let index = 0; index < samples.length; index += 1) {
          channelData[index] = samples[index] / 32768;
        }

        const source = playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(playbackContext.destination);
        source.start(startTime);
        playbackSourcesRef.current.push(source);
        startTime += audioBuffer.duration;
      }

      await new Promise((resolve) => {
        const timeout = window.setTimeout(
          resolve,
          Math.max((startTime - playbackContext.currentTime) * 1000, 0)
        );
        playbackResolveRef.current = () => {
          window.clearTimeout(timeout);
          resolve(undefined);
        };
      });
    } finally {
      agentSpeakingRef.current = false;
      playbackResolveRef.current = null;
      playbackSourcesRef.current = [];
    }
  }

  function interruptAgentPlayback() {
    for (const source of playbackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Ignore already-ended playback sources.
      }
    }

    playbackSourcesRef.current = [];
    playbackResolveRef.current?.();
    playbackResolveRef.current = null;
    agentSpeakingRef.current = false;
    setAudioNotice("Interrupted; listening");
  }

  return (
    <main className="demo-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Prescription Refill Voice Agent</p>
          <h1>Simulated call workflow</h1>
        </div>
        <div className="header-actions">
          <StatusBadge label={formatCallStatus(callStatus)} tone={callStatus} />
          <StatusBadge
            label={session?.state.nextExpectedStep ?? "not started"}
            tone="neutral"
          />
        </div>
      </header>

      <section className="workspace-grid">
        <section className="call-panel" aria-label="Live call transcript">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Call mode</p>
              <h2>Live transcript</h2>
            </div>
            <div className="panel-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setIsMuted((value) => !value)}
                disabled={!session || session.state.status !== "active"}
              >
                {isMuted ? "Unmute" : "Mute"}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={startCall}
                disabled={isBusy || callStatus === "connected"}
              >
                {callStatus === "idle" ? "Start call" : "Restart call"}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={hangUp}
                disabled={!session || session.state.channel !== "call"}
              >
                Hang up
              </button>
            </div>
          </div>

          <div className="state-strip" aria-label="Workflow status">
            <StatusBadge label={audioNotice} tone={isMuted ? "warning" : "neutral"} />
            <StatusBadge
              label={session?.state.identityVerified ? "verified" : "not verified"}
              tone={session?.state.identityVerified ? "good" : "warning"}
            />
            <StatusBadge
              label={session?.state.insuranceVerified ? "insurance verified" : "insurance pending"}
              tone={session?.state.insuranceVerified ? "good" : "neutral"}
            />
            <StatusBadge
              label={refillRequest ? `refill ${refillRequest.status.toLowerCase()}` : "no refill yet"}
              tone={refillRequest ? "good" : "neutral"}
            />
          </div>

          <div className="transcript-window">
            {messages.length === 0 ? (
              <div className="empty-transcript">
                <p>Start a call to create a backend session and open the voice provider.</p>
              </div>
            ) : (
              messages.map((message) => (
                <article
                  className={`message-row message-${message.role}`}
                  key={message.id}
                >
                  <div className="message-meta">
                    <span>{formatRole(message.role)}</span>
                    <time dateTime={message.createdAt}>
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </time>
                  </div>
                  <p>{message.content}</p>
                </article>
              ))
            )}
            {isBusy ? (
              <div className="typing-indicator" aria-live="polite">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            <div ref={transcriptEndRef} />
          </div>

          <form className="turn-form" onSubmit={submitTurn}>
            <input
              aria-label="Patient call input"
              placeholder={
                canSend
                  ? "Type the patient's spoken response..."
                  : "Start a call to enable patient input"
              }
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={!canSend}
            />
            <button type="submit" disabled={!canSend || !input.trim()}>
              Send
            </button>
          </form>

          {error ? <p className="error-banner">{error}</p> : null}
        </section>

        <aside className="debug-panel" aria-label="Session state">
          <div className="panel-header compact">
            <div>
              <p className="panel-kicker">Session state</p>
              <h2>Workflow snapshot</h2>
            </div>
          </div>

          <dl className="state-list">
            <div>
              <dt>Session</dt>
              <dd>{session ? `#${session.id}` : "None"}</dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>{session?.state.channel ?? "idle"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{session?.state.status ?? "idle"}</dd>
            </div>
            <div>
              <dt>Current step</dt>
              <dd>{session?.state.nextExpectedStep ?? "not started"}</dd>
            </div>
            <div>
              <dt>Collected</dt>
              <dd>{workflowSummary}</dd>
            </div>
          </dl>

          <div className="sms-panel">
            <div>
              <p className="panel-kicker">SMS mode</p>
              <h2>
                {session?.state.channel === "sms"
                  ? "Fallback ready"
                  : "Fallback inactive"}
              </h2>
            </div>
            <p>
              {session?.state.channel === "sms"
                ? "The call has moved to SMS continuation. Continue the same refill without repeating completed steps."
                : "SMS remains text/template-first. This panel stays inactive until fallback is triggered."}
            </p>
            <div className="sms-thread" aria-label="SMS continuation thread">
              {smsMessages.length > 0 ? (
                smsMessages.map((message) => (
                  <article
                    className={`sms-bubble sms-${message.role}`}
                    key={message.id}
                  >
                    <span>{formatRole(message.role)}</span>
                    <p>{message.content}</p>
                  </article>
                ))
              ) : (
                <p className="sms-empty">
                  Hang up before completion to generate the first SMS continuation.
                </p>
              )}
            </div>
            <form className="sms-form" onSubmit={submitSms}>
              <input
                aria-label="Patient SMS reply"
                placeholder={
                  canSendSms ? "Reply by SMS..." : "SMS activates after hang-up"
                }
                value={smsInput}
                onChange={(event) => setSmsInput(event.target.value)}
                disabled={!canSendSms}
              />
              <button type="submit" disabled={!canSendSms || !smsInput.trim()}>
                Send
              </button>
            </form>
          </div>
        </aside>
      </section>
    </main>
  );
}

function StatusBadge({
  label,
  tone
}: {
  label: string;
  tone: string;
}) {
  return <span className={`status-badge status-${tone}`}>{label}</span>;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = (await response.json()) as unknown;

  if (!response.ok) {
    throw new Error(isErrorResponse(data) ? data.error : "Request failed");
  }

  return data as T;
}

function isErrorResponse(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function formatRole(role: MessageRole) {
  switch (role) {
    case "assistant":
      return "Agent";
    case "user":
      return "Patient";
    case "tool":
      return "Tool";
    case "system":
      return "System";
  }
}

function formatCallStatus(status: CallStatus) {
  switch (status) {
    case "idle":
      return "idle";
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "listening":
      return "listening";
    case "processing":
      return "processing speech";
    case "speaking":
      return "agent speaking";
    case "thinking":
      return "agent responding";
    case "ended":
      return "ended";
  }
}

function getSmsThreadMessages(
  messages: TranscriptMessage[],
  smsActive: boolean
) {
  const fallbackIndex = messages.findIndex(
    (message) =>
      message.role === "system" &&
      message.content.includes("SMS fallback activated")
  );
  const threadMessages =
    fallbackIndex >= 0 ? messages.slice(fallbackIndex + 1) : smsActive ? messages : [];

  return threadMessages.filter(
    (message) => message.role === "assistant" || message.role === "user"
  );
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function getRms(samples: Float32Array) {
  let sum = 0;

  for (const sample of samples) {
    sum += sample * sample;
  }

  return Math.sqrt(sum / samples.length);
}

function convertFloat32ToPcm16(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number
) {
  const ratio = sourceRate / targetRate;
  const length = Math.floor(samples.length / ratio);
  const pcm = new Int16Array(length);

  for (let index = 0; index < length; index += 1) {
    const sourceIndex = Math.floor(index * ratio);
    const sample = Math.max(-1, Math.min(1, samples[sourceIndex] ?? 0));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return pcm;
}

function int16ToBase64(samples: Int16Array) {
  const bytes = new Uint8Array(samples.buffer);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return window.btoa(binary);
}

function concatInt16(chunks: Int16Array[]) {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const combined = new Int16Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined;
}

function base64ToInt16(base64: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Int16Array(bytes.buffer);
}

function getPcmRate(mimeType?: string) {
  const match = mimeType?.match(/rate=(\d+)/);

  return match ? Number(match[1]) : undefined;
}
