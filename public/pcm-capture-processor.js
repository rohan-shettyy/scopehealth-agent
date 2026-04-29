/**
 * AudioWorklet processor for capturing microphone PCM data.
 * Replaces the deprecated ScriptProcessorNode.
 *
 * Runs in an AudioWorkletNode on the audio rendering thread.
 * Posts Float32Array chunks to the main thread via port.postMessage.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Copy the samples (Float32, mono channel 0) and send to main thread
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true; // keep processor alive
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
