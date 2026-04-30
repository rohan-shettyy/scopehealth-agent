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
  refillRequest?: RefillRequestSnapshot;
  voiceEvents?: VoiceEvent[];
}

interface RefillRequestSnapshot {
  id: number;
  patientId: number;
  prescriptionId?: number;
  pharmacyId?: number;
  alternatePharmacy?: string;
  insurancePolicyId?: number;
  status: string;
  identityVerified: boolean;
  verifiedAt?: string;
  insuranceVerified: boolean;
  copayAmountCents?: number;
  lastCompletedStep?: string;
  nextExpectedStep?: string;
  createdAt: string;
  updatedAt: string;
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
  refillRequest?: RefillRequestSnapshot;
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

type MicStatus = "idle" | "requesting" | "granted" | "unavailable" | "stopped";
type VoiceStatus = "idle" | "connecting" | "live" | "text-fallback" | "unavailable" | "closed";

export default function Home() {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [pendingCaption, setPendingCaption] = useState<TranscriptMessage | null>(null);
  const [refillRequest, setRefillRequest] =
    useState<TranscriptResponse["refillRequest"]>();
  const [input, setInput] = useState("");
  const [smsInput, setSmsInput] = useState("");
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [audioNotice, setAudioNotice] = useState("Microphone idle");
  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
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
  const preSpeechChunksRef = useRef<Int16Array[]>([]);
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
  const fallbackTriggered = messages.some(
    (message) =>
      message.role === "system" &&
      message.content.includes("SMS fallback activated")
  );
  const primaryMode = session?.state.channel === "sms" || fallbackTriggered
    ? "sms"
    : "call";
  const callCaptionMessages = useMemo(
    () => getCallCaptionMessages(messages, pendingCaption),
    [messages, pendingCaption]
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

  useEffect(() => {
    const sessionId = window.localStorage.getItem("refill-demo-session-id");

    if (sessionId && !session) {
      void refreshSession(Number(sessionId), { quiet: true });
    }
  }, [session]);

  async function startCall() {
    setError(null);
    setCallStatus("connecting");
    setVoiceStatus("connecting");
    setMicStatus("requesting");
    setAudioNotice("Requesting microphone access");

    let mediaStream: MediaStream;

    try {
      mediaStream = await requestMicrophone();
      setMicStatus("granted");
    } catch (caughtError) {
      await startTextFallbackCall(caughtError);
      return;
    }

    try {
      const data = await postJson<TranscriptResponse>("/api/workflow/call/start");
      applyTranscript(data);

      try {
        await startAudioCapture(data.session.id, mediaStream);
      } catch (caughtError) {
        mediaStream.getTracks().forEach((track) => track.stop());
        setCallStatus("connected");
        setMicStatus("unavailable");
        setVoiceStatus(getVoiceStatusFromTranscript(data.messages, data.voiceEvents));
        setAudioNotice("Text-input call mode active");
        setError(
          `Microphone setup failed after the call connected. Continue with text input. ${formatError(caughtError)}`
        );
        return;
      }

      let playbackFailed = false;

      try {
        await playModelAudio(data.voiceEvents ?? []);
      } catch (caughtError) {
        playbackFailed = true;
        setVoiceStatus("text-fallback");
        setError(
          `Spoken audio playback failed. Continue with text input. ${formatError(caughtError)}`
        );
      }

      setCallStatus("listening");
      if (!playbackFailed) {
        setVoiceStatus(getVoiceStatusFromTranscript(data.messages, data.voiceEvents));
      }
      setAudioNotice("Listening for patient speech");
    } catch (caughtError) {
      await stopAudioCapture();
      mediaStream.getTracks().forEach((track) => track.stop());
      setCallStatus("idle");
      setVoiceStatus("unavailable");
      setError(formatError(caughtError));
    }
  }

  async function requestMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not available in this browser.");
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: { ideal: 16000 },
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true
      }
    });
  }

  async function startTextFallbackCall(caughtError: unknown) {
    try {
      const data = await postJson<TranscriptResponse>("/api/workflow/call/start");

      applyTranscript(data);
      setCallStatus("connected");
      setMicStatus("unavailable");
      const inferredVoiceStatus = getVoiceStatusFromTranscript(
        data.messages,
        data.voiceEvents
      );
      setVoiceStatus(
        inferredVoiceStatus === "live" ? "text-fallback" : inferredVoiceStatus
      );
      setAudioNotice("Text-input call mode active");
      setError(
        `Microphone or voice audio was unavailable, so the demo is continuing in text-input call mode. ${formatError(caughtError)}`
      );
    } catch (fallbackError) {
      setCallStatus("idle");
      setMicStatus("unavailable");
      setVoiceStatus("unavailable");
      setError(formatError(fallbackError));
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
      setVoiceStatus(getVoiceStatusFromTranscript(messages, data.voiceEvents));
      setCallStatus(data.session.state.status === "completed" ? "ended" : "connected");
    } catch (caughtError) {
      setCallStatus("connected");
      setVoiceStatus("text-fallback");
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
      setVoiceStatus("closed");
      setAudioNotice("Call ended; SMS fallback active");
    } catch (caughtError) {
      setCallStatus("ended");
      setVoiceStatus("closed");
      setError(formatError(caughtError));
    }
  }

  async function resetCall() {
    const sessionId = session?.id;

    setError(null);
    setAudioNotice("Resetting demo call");
    setCallStatus("thinking");

    try {
      await stopAudioCapture();

      if (playbackContextRef.current?.state !== "closed") {
        await playbackContextRef.current?.close();
      }
      playbackContextRef.current = null;

      if (sessionId) {
        await postJson<{ reset: true }>("/api/workflow/call/reset", {
          sessionId
        });
      }
    } catch (caughtError) {
      setError(`Reset cleanup warning: ${formatError(caughtError)}`);
    } finally {
      window.localStorage.removeItem("refill-demo-session-id");
      setSession(null);
      setMessages([]);
      setPendingCaption(null);
      setRefillRequest(undefined);
      setInput("");
      setSmsInput("");
      setIsMuted(false);
      setCallStatus("idle");
      setMicStatus("idle");
      setVoiceStatus("idle");
      setAudioNotice("Microphone idle");
    }
  }

  async function submitSms(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = smsInput.trim();

    if (!session || !text) {
      return;
    }

    setError(null);
    setSmsInput("");

    try {
      const data = await postJson<TurnResponse>("/api/workflow/sms/reply", {
        sessionId: session.id,
        text
      });
      setSession(data.session);
      setRefillRequest(data.refillRequest);
      await refreshSession(data.session.id, { quiet: true });
      if (data.session.state.status === "completed") {
        setCallStatus("ended");
        setAudioNotice("Refill completed by SMS");
      }
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
    const inferredVoiceStatus = getVoiceStatusFromTranscript(
      data.messages,
      data.voiceEvents
    );

    setSession(data.session);
    setMessages(data.messages);
    setRefillRequest(data.refillRequest);
    window.localStorage.setItem("refill-demo-session-id", String(data.session.id));
    setVoiceStatus((current) =>
      current === "closed" || inferredVoiceStatus === "idle"
        ? current
        : inferredVoiceStatus
    );

    if (data.session.state.status === "completed") {
      setCallStatus("ended");
      window.localStorage.removeItem("refill-demo-session-id");
    } else if (data.session.state.channel === "sms") {
      setCallStatus("ended");
    } else if (data.session.state.channel === "call") {
      setCallStatus((current) => current === "idle" ? "connected" : current);
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
    preSpeechChunksRef.current = [];

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
      const pcm = convertFloat32ToPcm16(
        inputBuffer,
        audioContext.sampleRate,
        16000
      );
      const speechDetected = rms > (agentSpeakingRef.current ? 0.03 : 0.01);

      if (pcm.length > 0 && !hasSpeechRef.current) {
        preSpeechChunksRef.current.push(pcm);

        if (preSpeechChunksRef.current.length > 12) {
          preSpeechChunksRef.current.shift();
        }
      }

      if (speechDetected) {
        if (agentSpeakingRef.current) {
          interruptAgentPlayback();
        }

        hasSpeechRef.current = true;
        utteranceStartedAtRef.current ??= now;
        silenceStartedAtRef.current = null;
        setCallStatus("listening");
        setAudioNotice("Listening: speech detected");

        if (preSpeechChunksRef.current.length > 0) {
          utteranceChunksRef.current.push(...preSpeechChunksRef.current);
          preSpeechChunksRef.current = [];
        }
      } else if (hasSpeechRef.current) {
        silenceStartedAtRef.current ??= now;

        if (
          now - silenceStartedAtRef.current > 1400 ||
          (utteranceStartedAtRef.current !== null &&
            now - utteranceStartedAtRef.current > 15000)
        ) {
          void finishAudioTurn();
          return;
        }
      }

      if (hasSpeechRef.current && pcm.length > 0) {
        utteranceChunksRef.current.push(pcm);
      }
    };

    source.connect(workletNode);
    const silentSink = audioContext.createGain();
    silentSink.gain.value = 0;
    workletNode.connect(silentSink);
    silentSink.connect(audioContext.destination);
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
    preSpeechChunksRef.current = [];
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
      const patientTranscript = getCanonicalUserTranscript(data.voiceEvents ?? []);

      if (patientTranscript) {
        setPendingCaption(createPendingCaption(patientTranscript));
        setAudioNotice("Patient speech transcribed");
      }

      setSession(data.session);
      setRefillRequest(data.refillRequest);
      await refreshSession(data.session.id, { quiet: true });
      setPendingCaption(null);
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
    setMicStatus((current) => current === "idle" ? current : "stopped");
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
          <h1>AI refill concierge</h1>
        </div>
        <div className="header-signal" aria-label="Agent status">
          <span />
          <strong>Gemini Live</strong>
        </div>
      </header>

      <section className={`workspace-grid mode-${primaryMode}`}>
        <section
          className={`device-surface device-${primaryMode}`}
          aria-label={primaryMode === "sms" ? "SMS messaging experience" : "Voice call experience"}
        >
          {primaryMode === "call" ? (
            <div className="call-screen">
              <div className="phone-status-row">
                <span>Voice call</span>
                <span>{callStatus === "idle" ? "Ready" : formatCallStatus(callStatus)}</span>
              </div>

              <div className="call-target">
                <div className="contact-avatar" aria-hidden="true">SC</div>
                <div>
                  <p className="panel-kicker">Calling</p>
                  <h2>Sarah Chen</h2>
                  <p className="target-subtitle">(555) 867-5309</p>
                </div>
              </div>

              <div className="call-state-card" aria-live="polite">
                <p className="call-state-label">{formatCallStatus(callStatus)}</p>
                <p className="call-state-copy">{getCallStateCopy(callStatus, audioNotice)}</p>
                <div className={`voice-orb voice-orb-${callStatus}`} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </div>

              <div className="call-control-row">
                <button
                  className="call-control"
                  type="button"
                  onClick={() => setIsMuted((value) => !value)}
                  disabled={!session || session.state.status !== "active"}
                >
                  {isMuted ? "Unmute" : "Mute"}
                </button>
                <button
                  className="call-control call-control-primary"
                  type="button"
                  onClick={startCall}
                  disabled={isBusy || callStatus === "connected"}
                >
                  {callStatus === "idle" ? "Start call" : "Reconnect"}
                </button>
                <button
                  className="call-control call-control-end"
                  type="button"
                  onClick={hangUp}
                  disabled={!session || session.state.channel !== "call"}
                >
                  Hang up
                </button>
                <button
                  className="call-control"
                  type="button"
                  onClick={resetCall}
                  disabled={!session && callStatus === "idle"}
                >
                  New session
                </button>
              </div>

              <details className="call-captions" open={voiceStatus !== "live"}>
                <summary>Call captions and notes</summary>
                <div className="caption-list">
                  {callCaptionMessages.length === 0 ? (
                    <p className="caption-empty">
                      Agent and patient captions appear here during the demo.
                    </p>
                  ) : (
                    callCaptionMessages.map((message) => (
                      <article className="caption-row" key={message.id}>
                        <span>{formatRole(message.role)}</span>
                        <p>{message.content}</p>
                      </article>
                    ))
                  )}
                  <div ref={transcriptEndRef} />
                </div>
              </details>

              {error ? <p className="error-banner">{error}</p> : null}
            </div>
          ) : (
            <div className="sms-screen">
              <div className="mode-transition-banner">
                <span>Call ended</span>
                <strong>Continuing by text</strong>
                <p>We switched this refill to SMS and kept the information already collected.</p>
              </div>

              <div className="sms-header">
                <div>
                  <p className="panel-kicker">Messages</p>
                  <h2>Sarah Chen</h2>
                  <p className="target-subtitle">Prescription refill SMS</p>
                </div>
                <div className="sms-header-actions">
                  <StatusBadge
                    label={session?.state.status === "completed" ? "refill completed" : "sms active"}
                    tone={session?.state.status === "completed" ? "good" : "connected"}
                  />
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={resetCall}
                  >
                    Call again
                  </button>
                </div>
              </div>

              <div className="sms-thread primary-sms-thread" aria-label="SMS continuation thread">
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
                    The first SMS continuation will appear after call fallback.
                  </p>
                )}
                <div ref={transcriptEndRef} />
              </div>

              <form className="sms-form primary-sms-form" onSubmit={submitSms}>
                <input
                  aria-label="Patient SMS reply"
                  placeholder={
                    canSendSms ? "Reply by SMS..." : "SMS conversation complete"
                  }
                  value={smsInput}
                  onChange={(event) => setSmsInput(event.target.value)}
                  disabled={!canSendSms}
                />
                <button type="submit" disabled={!canSendSms || !smsInput.trim()}>
                  Send
                </button>
              </form>

              {error ? <p className="error-banner sms-error">{error}</p> : null}
            </div>
          )}
        </section>

        <aside className="debug-panel" aria-label="Session state">
          <div className="panel-header compact">
            <div>
              <p className="panel-kicker">Agent memory</p>
              <h2>Refill context</h2>
            </div>
          </div>

          <dl className="state-list">
            <div>
              <dt>Current step</dt>
              <dd>{session?.state.nextExpectedStep ?? "not started"}</dd>
            </div>
            <div>
              <dt>Collected</dt>
              <dd>{workflowSummary}</dd>
            </div>
            <div>
              <dt>Medication</dt>
              <dd>
                {session?.state.selectedMedication
                  ? `${session.state.selectedMedication.medicationName} ${session.state.selectedMedication.strength}`
                  : "pending"}
              </dd>
            </div>
            <div>
              <dt>Pharmacy</dt>
              <dd>
                {session?.state.selectedPharmacy
                  ? formatPharmacy(session.state.selectedPharmacy)
                  : "pending"}
              </dd>
            </div>
            <div>
              <dt>Insurance</dt>
              <dd>{session?.state.insuranceVerified ? "verified" : "pending"}</dd>
            </div>
            <div>
              <dt>Copay</dt>
              <dd>
                {session?.state.copayAmountCents !== undefined
                  ? formatCurrency(session.state.copayAmountCents)
                  : "pending"}
              </dd>
            </div>
          </dl>

          <section className="refill-summary" aria-label="Completed refill request">
            <p className="panel-kicker">Refill request</p>
            {refillRequest ? (
              <dl className="refill-list">
                <div>
                  <dt>ID</dt>
                  <dd>#{refillRequest.id}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{refillRequest.status.toLowerCase()}</dd>
                </div>
                <div>
                  <dt>Prescription</dt>
                  <dd>
                    {session?.state.selectedMedication
                      ? `${session.state.selectedMedication.medicationName} ${session.state.selectedMedication.strength}`
                      : refillRequest.prescriptionId
                        ? `Prescription #${refillRequest.prescriptionId}`
                        : "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt>Pharmacy</dt>
                  <dd>
                    {session?.state.selectedPharmacy
                      ? formatPharmacy(session.state.selectedPharmacy)
                      : refillRequest.alternatePharmacy ??
                        (refillRequest.pharmacyId
                          ? `Pharmacy #${refillRequest.pharmacyId}`
                          : "Not recorded")}
                  </dd>
                </div>
                <div>
                  <dt>Copay</dt>
                  <dd>
                    {refillRequest.copayAmountCents !== undefined
                      ? formatCurrency(refillRequest.copayAmountCents)
                      : "Not recorded"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="refill-empty">
                No completed refill request yet.
              </p>
            )}
          </section>

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

function getCallStateCopy(status: CallStatus, audioNotice: string) {
  switch (status) {
    case "idle":
      return "Ready to start a simulated refill call.";
    case "connecting":
      return "Connecting the refill assistant and requesting microphone access.";
    case "connected":
      return "Call connected. Voice is available when the microphone is ready.";
    case "listening":
      return audioNotice;
    case "processing":
      return "Processing the patient's last spoken response.";
    case "speaking":
      return "The agent is speaking. Patient speech will interrupt playback.";
    case "thinking":
      return "Ending or updating the call state.";
    case "ended":
      return "The call has ended.";
  }
}

function getCallCaptionMessages(
  messages: TranscriptMessage[],
  pendingCaption: TranscriptMessage | null
) {
  const fallbackIndex = messages.findIndex(
    (message) =>
      message.role === "system" &&
      message.content.includes("SMS fallback activated")
  );
  const callMessages = fallbackIndex >= 0 ? messages.slice(0, fallbackIndex) : messages;
  const visibleMessages = pendingCaption
    ? [...callMessages, pendingCaption]
    : callMessages;

  return visibleMessages.filter(
    (message) => message.role !== "tool"
  );
}

function getCanonicalUserTranscript(events: VoiceEvent[]) {
  return events
    .filter((event) => event.type === "user_transcript" && event.text?.trim())
    .at(-1)
    ?.text
    ?.trim();
}

function createPendingCaption(content: string): TranscriptMessage {
  return {
    id: -Date.now(),
    role: "user",
    content,
    sequence: Number.MAX_SAFE_INTEGER,
    createdAt: new Date().toISOString()
  };
}

function getVoiceStatusFromTranscript(
  messages: TranscriptMessage[],
  voiceEvents?: VoiceEvent[]
): VoiceStatus {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join(" ");

  if (systemText.includes("Gemini Live unavailable")) {
    return "unavailable";
  }

  if (
    systemText.includes("text-input call mode") ||
    systemText.includes("Gemini voice turn failed")
  ) {
    return "text-fallback";
  }

  if (systemText.includes("SMS fallback activated")) {
    return "closed";
  }

  if (voiceEvents?.some((event) => event.provider === "gemini-live")) {
    return "live";
  }

  return "idle";
}

function formatVoiceStatus(status: VoiceStatus) {
  switch (status) {
    case "idle":
      return "idle";
    case "connecting":
      return "connecting";
    case "live":
      return "gemini live";
    case "text-fallback":
      return "text fallback";
    case "unavailable":
      return "unavailable";
    case "closed":
      return "closed";
  }
}

function voiceStatusTone(status: VoiceStatus) {
  switch (status) {
    case "live":
      return "good";
    case "connecting":
    case "text-fallback":
      return "warning";
    case "unavailable":
    case "closed":
      return "ended";
    case "idle":
      return "neutral";
  }
}

function formatMicStatus(status: MicStatus) {
  switch (status) {
    case "idle":
      return "idle";
    case "requesting":
      return "requesting";
    case "granted":
      return "ready";
    case "unavailable":
      return "unavailable";
    case "stopped":
      return "stopped";
  }
}

function micStatusTone(status: MicStatus) {
  switch (status) {
    case "granted":
      return "good";
    case "requesting":
      return "warning";
    case "unavailable":
    case "stopped":
      return "ended";
    case "idle":
      return "neutral";
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

function formatPharmacy(pharmacy: {
  name: string;
  addressLine1?: string;
}) {
  return pharmacy.addressLine1
    ? `${pharmacy.name}, ${pharmacy.addressLine1}`
    : pharmacy.name;
}

function formatCurrency(amountCents: number) {
  return `$${(amountCents / 100).toFixed(2).replace(/\.00$/, "")}`;
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
