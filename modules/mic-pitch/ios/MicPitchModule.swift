import ExpoModulesCore
import AVFoundation

/**
 * Streaming mic pitch detection for the tuner.
 *
 * Taps AVAudioEngine's input node and runs YIN over a sliding window, emitting an
 * `onPitch` event every HOP samples (~21ms at 48kHz → ~47 readings/sec). The previous
 * tuner recorded a WAV to disk and re-analyzed the whole clip per reading, costing 700ms+
 * per update; nothing here touches the filesystem.
 *
 * The audio render thread only copies samples into a queue — YIN runs on `analysisQueue`.
 * The DSP itself lives in YinDetector.swift so it can be unit-tested standalone.
 */
public class MicPitchModule: Module {

  // MARK: - Analysis config

  /// Sliding window fed to YIN. Must be >= 2x the longest period we want to resolve.
  private let windowSize = 2048
  /// Advance per reading. 1024 @ 48kHz ≈ 21ms → ~47 events/sec.
  private let hopSize = 1024

  private let detector = YinDetector()

  // MARK: - State (all `ring` access is confined to analysisQueue)

  private let engine = AVAudioEngine()
  private let analysisQueue = DispatchQueue(label: "com.stringai.micpitch.analysis", qos: .userInitiated)

  private var ring: [Float] = []
  private var currentSampleRate: Double = 0
  private var isRunning = false
  /// Silence produces no useful readings; emit only every Nth to keep the bridge quiet.
  private var unvoicedCounter = 0

  // MARK: - Module definition

  public func definition() -> ModuleDefinition {
    Name("MicPitch")

    Events("onPitch")

    AsyncFunction("start") { (promise: Promise) in
      do {
        try self.startEngine()
        promise.resolve(nil)
      } catch {
        promise.reject("MIC_START_FAILED", error.localizedDescription)
      }
    }

    AsyncFunction("stop") { (promise: Promise) in
      self.stopEngine()
      promise.resolve(nil)
    }

    // Not pitch-specific — a general audio-routing fix that happens to live on
    // this module because it's the app's one existing bridge to AVAudioSession.
    // A `.playAndRecord` session (recording while also playing back, e.g. the
    // metronome click during a take) defaults output to the quiet earpiece
    // unless explicitly overridden. expo-av exposes no JS option for this.
    AsyncFunction("forceSpeaker") { (promise: Promise) in
      try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.speaker)
      promise.resolve(nil)
    }

    // Puts the shared session into the same measurement mode the pitch engine
    // uses, without starting the engine. The graded exercise take is recorded by
    // expo-av, which cannot express `mode:`, so it was being captured with iOS
    // AGC and noise-suppression active — the exact processing that `startEngine`
    // turns off below because it makes detected pitch drift under a sustained
    // tone. The tuner and the grader were therefore judging different signals.
    AsyncFunction("configureMeasurementSession") { (promise: Promise) in
      do {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setPreferredSampleRate(48000)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        promise.resolve(nil)
      } catch {
        promise.reject("MIC_SESSION_FAILED", error.localizedDescription)
      }
    }

    OnDestroy {
      self.stopEngine()
    }
  }

  // MARK: - Engine lifecycle

  private func startEngine() throws {
    guard !isRunning else { return }

    let session = AVAudioSession.sharedInstance()
    // .measurement disables AGC and the input EQ/noise-suppression chain. Without it iOS
    // reshapes the signal and the detected pitch drifts under a sustained tone.
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
    try session.setPreferredSampleRate(48000)
    try session.setPreferredIOBufferDuration(0.01)
    try session.setActive(true, options: .notifyOthersOnDeactivation)

    let input = engine.inputNode
    // installTap traps if the format doesn't match the node's own input format.
    let format = input.inputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw MicPitchError.noInputAvailable
    }

    analysisQueue.async {
      self.ring.removeAll(keepingCapacity: true)
      self.currentSampleRate = format.sampleRate
      self.unvoicedCounter = 0
    }

    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(hopSize), format: format) { [weak self] buffer, _ in
      guard let self, let channels = buffer.floatChannelData else { return }
      let frames = Int(buffer.frameLength)
      guard frames > 0 else { return }

      // Copy off the render thread immediately — everything downstream is async.
      let samples = Array(UnsafeBufferPointer(start: channels[0], count: frames))
      let sr = buffer.format.sampleRate

      self.analysisQueue.async {
        self.ingest(samples, sampleRate: sr)
      }
    }

    engine.prepare()
    try engine.start()
    isRunning = true

    registerNotifications()
  }

  private func stopEngine() {
    guard isRunning else { return }
    isRunning = false

    unregisterNotifications()

    engine.inputNode.removeTap(onBus: 0)
    engine.stop()

    analysisQueue.async {
      self.ring.removeAll(keepingCapacity: false)
    }

    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  // MARK: - Interruptions / route changes

  private func registerNotifications() {
    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(handleInterruption(_:)),
                   name: AVAudioSession.interruptionNotification, object: nil)
    nc.addObserver(self, selector: #selector(handleRouteChange(_:)),
                   name: AVAudioSession.routeChangeNotification, object: nil)
  }

  private func unregisterNotifications() {
    NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
    NotificationCenter.default.removeObserver(self, name: AVAudioSession.routeChangeNotification, object: nil)
  }

  /// A phone call would otherwise leave the engine stopped and the tuner silently frozen.
  @objc private func handleInterruption(_ note: Notification) {
    guard let info = note.userInfo,
          let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }

    switch type {
    case .began:
      engine.pause()
    case .ended:
      let opts = (info[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init)
      if opts?.contains(.shouldResume) == true, isRunning {
        try? AVAudioSession.sharedInstance().setActive(true)
        try? engine.start()
      }
    @unknown default:
      break
    }
  }

  /// Plugging in headphones swaps the input node's format; the tap has to be rebuilt around it.
  @objc private func handleRouteChange(_ note: Notification) {
    guard isRunning,
          let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }

    switch reason {
    case .newDeviceAvailable, .oldDeviceUnavailable, .routeConfigurationChange:
      stopEngine()
      try? startEngine()
    default:
      break
    }
  }

  // MARK: - Ingest

  /// Appends new samples and drains the ring one hop at a time. analysisQueue only.
  private func ingest(_ samples: [Float], sampleRate: Double) {
    if sampleRate != currentSampleRate {
      currentSampleRate = sampleRate
      ring.removeAll(keepingCapacity: true)
    }

    ring.append(contentsOf: samples)

    while ring.count >= windowSize {
      emit(detector.analyze(Array(ring[0..<windowSize]), sampleRate: sampleRate))
      ring.removeFirst(hopSize)
    }

    // A stalled consumer must never let this grow without bound.
    if ring.count > windowSize * 4 {
      ring.removeFirst(ring.count - windowSize)
    }
  }

  private func emit(_ estimate: PitchEstimate) {
    guard estimate.voiced else {
      unvoicedCounter += 1
      guard unvoicedCounter % 4 == 0 else { return }
      sendEvent("onPitch", [
        "hz": 0.0,
        "clarity": 0.0,
        "rms": Double(estimate.rms),
        "voiced": false,
      ])
      return
    }

    unvoicedCounter = 0
    sendEvent("onPitch", [
      "hz": estimate.hz,
      "clarity": Double(estimate.clarity),
      "rms": Double(estimate.rms),
      "voiced": true,
    ])
  }
}

private enum MicPitchError: Error, LocalizedError {
  case noInputAvailable

  var errorDescription: String? {
    switch self {
    case .noInputAvailable:
      return "No audio input is available on this device."
    }
  }
}
