import ExpoModulesCore
import AVFoundation
import Vision
import MediaPipeTasksVision

public class PoseCameraView: ExpoView,
                              AVCaptureVideoDataOutputSampleBufferDelegate,
                              AVCaptureAudioDataOutputSampleBufferDelegate,
                              AVCaptureFileOutputRecordingDelegate {

    // MARK: - Events
    let onPose              = EventDispatcher()
    let onRecordingFinished = EventDispatcher()
    let onCameraReady       = EventDispatcher()
    let onPitch             = EventDispatcher()

    // MARK: - AV stack
    private let session     = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let movieOutput = AVCaptureMovieFileOutput()
    private let frameOutput = AVCaptureVideoDataOutput()
    private let frameQueue  = DispatchQueue(label: "pose.frames", qos: .userInteractive)
    private let audioOutput = AVCaptureAudioDataOutput()
    private let audioQueue  = DispatchQueue(label: "pose.audio", qos: .utility)

    // MARK: - Audio ring buffer (for real-time vibrato monitoring)
    private var audioRing:    ContiguousArray<Float> = []
    private var audioRingPos: Int  = 0
    private var audioRingFull: Bool = false
    private var audioRingRate: Double = 0
    private let audioLock = NSLock()

    // MARK: - Real-time pitch (autocorrelation, 20 Hz via audioQueue)
    private var pitchAccum = ContiguousArray<Float>()
    private let pitchEmitInterval = 2205  // 50 ms at 44100 Hz

    // MARK: - Vision (body pose + hand chirality/image-coords)
    private let poseRequest = VNDetectHumanBodyPoseRequest()
    private let handRequest: VNDetectHumanHandPoseRequest = {
        let r = VNDetectHumanHandPoseRequest()
        r.maximumHandCount = 2
        return r
    }()
    private var lastPoseTime: Double = 0
    private let poseInterval: Double = 1.0 / 15.0

    // MARK: - Bow detection (CoreML, ~10 fps)
    private var lastBowTime: Double = 0
    private let bowInterval: Double = 0.10   // 100 ms — matches ~1 inference cycle
    private lazy var bowCIContext = CIContext(options: [.useSoftwareRenderer: false])

    // MARK: - MediaPipe (world landmarks for palm orientation + body pose)
    private var handLandmarker: HandLandmarker?
    private var poseLandmarker: PoseLandmarker?

    // When true, runs MediaPipe PoseLandmarker on each frame to enrich body joints
    // with 3D world coordinates (wx/wy/wz). Falls back to Vision-only (2D) when false.
    // Set via the `useMpPose` React Native prop; default off so existing behaviour is unchanged.
    var useMpPose: Bool = false {
        didSet {
            if useMpPose && poseLandmarker == nil {
                setupPoseLandmarker()
            }
        }
    }

    static weak var current: PoseCameraView?

    // MARK: - Init

    required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil && PoseCameraView.current !== self {
            PoseCameraView.current = self
            setupCamera()
        }
    }

    // The preview layer is always landscape-sized and rotated 90° CW so it fills
    // the portrait-locked UIView correctly when the phone is held landscape.
    public override func layoutSubviews() {
        super.layoutSubviews()
        let w = bounds.width, h = bounds.height
        previewLayer?.bounds   = CGRect(x: 0, y: 0, width: h, height: w)
        previewLayer?.position = CGPoint(x: w / 2, y: h / 2)
    }

    // MARK: - Camera setup

    func setupCamera() {
        setupHandLandmarker()

        session.beginConfiguration()
        session.sessionPreset = .high

        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
            let videoIn = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(videoIn)
        else { session.commitConfiguration(); return }
        session.addInput(videoIn)

        if let mic = AVCaptureDevice.default(for: .audio),
           let audioIn = try? AVCaptureDeviceInput(device: mic),
           session.canAddInput(audioIn) {
            session.addInput(audioIn)
        }

        frameOutput.alwaysDiscardsLateVideoFrames = true
        frameOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        frameOutput.setSampleBufferDelegate(self, queue: frameQueue)
        if session.canAddOutput(frameOutput) {
            session.addOutput(frameOutput)
            if let conn = frameOutput.connection(with: .video) {
                // Always capture landscape — the user holds the phone sideways to record.
                if conn.isVideoOrientationSupported { conn.videoOrientation = .landscapeRight }
                if conn.isVideoMirroringSupported   { conn.isVideoMirrored = false }
            }
        }

        // movieOutput must be added before audioOutput so it can establish
        // its own audio connection; adding audioOutput first can prevent this.
        if session.canAddOutput(movieOutput) {
            session.addOutput(movieOutput)
            if let conn = movieOutput.connection(with: .video) {
                if conn.isVideoOrientationSupported { conn.videoOrientation = .landscapeRight }
                if conn.isVideoMirroringSupported   { conn.isVideoMirrored = true }
            }
            if let audioConn = movieOutput.connection(with: .audio) {
                audioConn.isEnabled = true
            }
        }

        audioOutput.setSampleBufferDelegate(self, queue: audioQueue)
        if session.canAddOutput(audioOutput) {
            session.addOutput(audioOutput)
        }

        session.commitConfiguration()

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        if let conn = preview.connection, conn.isVideoOrientationSupported {
            conn.videoOrientation = .landscapeRight
        }
        // Rotate the preview layer 90° CW once so the landscape feed fills the screen
        // when the user holds the phone sideways. bounds/position (not frame) must be
        // used here because frame is undefined when a transform is applied.
        let w = bounds.width, h = bounds.height
        preview.bounds   = CGRect(x: 0, y: 0, width: h, height: w)
        preview.position = CGPoint(x: w / 2, y: h / 2)
        preview.transform = CATransform3DMakeRotation(CGFloat.pi / 2, 0, 0, 1)
        layer.addSublayer(preview)
        previewLayer = preview

        DispatchQueue.global(qos: .userInitiated).async {
            self.session.startRunning()
            DispatchQueue.main.async { self.onCameraReady([:]) }
        }
    }

    private func setupHandLandmarker() {
        let modelPath = Bundle(for: PoseCameraView.self).path(forResource: "hand_landmarker", ofType: "task")
            ?? Bundle.main.path(forResource: "hand_landmarker", ofType: "task")
        guard let modelPath else {
            print("[PoseCamera] hand_landmarker.task not found — world landmarks unavailable")
            return
        }
        do {
            let options = HandLandmarkerOptions()
            options.baseOptions.modelAssetPath = modelPath
            options.numHands = 2
            options.minHandDetectionConfidence = 0.5
            options.minHandPresenceConfidence  = 0.5
            options.minTrackingConfidence      = 0.5
            options.runningMode = .image
            handLandmarker = try HandLandmarker(options: options)
        } catch {
            print("[PoseCamera] HandLandmarker init failed: \(error)")
        }
    }

    private func setupPoseLandmarker() {
        let modelPath = Bundle(for: PoseCameraView.self).path(forResource: "pose_landmarker_full", ofType: "task")
            ?? Bundle.main.path(forResource: "pose_landmarker_full", ofType: "task")
        guard let modelPath else {
            print("[PoseCamera] pose_landmarker_full.task not found — 3D wrist angle unavailable.")
            return
        }
        do {
            let options = PoseLandmarkerOptions()
            options.baseOptions.modelAssetPath = modelPath
            options.numPoses = 1
            options.minPoseDetectionConfidence = 0.5
            options.minPosePresenceConfidence  = 0.5
            options.minTrackingConfidence      = 0.5
            options.runningMode = .image
            poseLandmarker = try PoseLandmarker(options: options)
            print("[PoseCamera] PoseLandmarker initialised — 3D wrist angle enabled")
        } catch {
            print("[PoseCamera] PoseLandmarker init failed: \(error)")
        }
    }

    // MARK: - Recording control

    func startRecording() {
        guard !movieOutput.isRecording else { return }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".mov")
        movieOutput.startRecording(to: url, recordingDelegate: self)
    }

    func stopRecording() {
        guard movieOutput.isRecording else { return }
        movieOutput.stopRecording()
    }

    // MARK: - Sample buffer delegate (video + audio)

    public func captureOutput(_ output: AVCaptureOutput,
                               didOutput sampleBuffer: CMSampleBuffer,
                               from connection: AVCaptureConnection) {
        if output === audioOutput {
            handleAudioBuffer(sampleBuffer)
            return
        }
        let now = CACurrentMediaTime()
        guard now - lastPoseTime >= poseInterval else { return }
        lastPoseTime = now
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        processFrame(pixelBuffer: pixelBuffer)
    }

    // MARK: - Audio tap

    private func handleAudioBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
        else { return }

        let sampleRate  = asbd.mSampleRate
        let numSamples  = CMSampleBufferGetNumSamples(sampleBuffer)
        guard numSamples > 0 else { return }

        let isFloat          = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0

        var mono = [Float](repeating: 0, count: numSamples)

        if isNonInterleaved {
            // Get required ABL size, then fill it
            var ablSize = 0
            CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sampleBuffer, bufferListSizeNeededOut: &ablSize,
                bufferListOut: nil, bufferListSize: 0,
                blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
                flags: 0, blockBufferOut: nil)
            guard ablSize > 0 else { return }

            var ablBytes = [UInt8](repeating: 0, count: ablSize)
            var retainedBB: CMBlockBuffer? = nil
            ablBytes.withUnsafeMutableBytes { ptr in
                _ = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                    sampleBuffer, bufferListSizeNeededOut: nil,
                    bufferListOut: ptr.baseAddress!.assumingMemoryBound(to: AudioBufferList.self),
                    bufferListSize: ablSize,
                    blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
                    flags: 0, blockBufferOut: &retainedBB)
            }
            guard retainedBB != nil else { return }
            defer { retainedBB = nil }

            ablBytes.withUnsafeMutableBytes { ptr in
                let abl = ptr.baseAddress!.assumingMemoryBound(to: AudioBufferList.self)
                let wrapped = UnsafeMutableAudioBufferListPointer(abl)
                guard !wrapped.isEmpty, let chData = wrapped[0].mData else { return }
                if isFloat {
                    let fp = chData.assumingMemoryBound(to: Float.self)
                    for i in 0..<numSamples { mono[i] = fp[i] }
                } else {
                    let ip = chData.assumingMemoryBound(to: Int16.self)
                    for i in 0..<numSamples { mono[i] = Float(ip[i]) / 32768.0 }
                }
            }
        } else {
            // Interleaved (ch 0 only for mono extraction)
            guard let blockBuf = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
            var totalLen = 0
            var dataPtr: UnsafeMutablePointer<CChar>? = nil
            guard CMBlockBufferGetDataPointer(blockBuf, atOffset: 0,
                                              lengthAtOffsetOut: nil,
                                              totalLengthOut: &totalLen,
                                              dataPointerOut: &dataPtr) == kCMBlockBufferNoErr,
                  let ptr = dataPtr else { return }
            let bytePtr = UnsafeRawPointer(ptr)
            if isFloat {
                bytePtr.withMemoryRebound(to: Float.self, capacity: totalLen / 4) { fp in
                    for i in 0..<numSamples { mono[i] = fp[i] }
                }
            } else {
                bytePtr.withMemoryRebound(to: Int16.self, capacity: totalLen / 2) { ip in
                    for i in 0..<numSamples { mono[i] = Float(ip[i]) / 32768.0 }
                }
            }
        }

        mono.withUnsafeBufferPointer { bp in
            guard let base = bp.baseAddress else { return }
            appendToRing(base, count: numSamples, sampleRate: sampleRate)
        }
        processPitchEmit(samples: mono)
    }

    // MARK: - Pitch emission (autocorrelation, runs on audioQueue)

    private func processPitchEmit(samples: [Float]) {
        pitchAccum.append(contentsOf: samples)
        guard pitchAccum.count >= pitchEmitInterval else { return }
        let chunk = Array(pitchAccum.prefix(pitchEmitInterval))
        pitchAccum.removeFirst(pitchEmitInterval)
        let freq = estimatePitch(from: chunk)
        let payload: [String: Any] = ["frequency": freq as Any]
        DispatchQueue.main.async { self.onPitch(payload) }
    }

    private func estimatePitch(from samples: [Float]) -> Double? {
        let n = samples.count
        var sumSq: Float = 0
        for s in samples { sumSq += s * s }
        guard sumSq / Float(n) > 0.0001 else { return nil }  // silence

        let minLag = max(1, Int(44100.0 / 1500.0))  // ≤ 1500 Hz
        let maxLag = min(n / 2 - 1, Int(44100.0 / 70.0))   // ≥ 70 Hz
        guard minLag < maxLag else { return nil }

        var bestLag = 0
        var bestCorr: Float = -Float.infinity
        samples.withUnsafeBufferPointer { ptr in
            let base = ptr.baseAddress!
            for lag in minLag...maxLag {
                var corr: Float = 0
                let limit = n - lag
                for i in 0..<limit { corr += base[i] * base[i + lag] }
                if corr > bestCorr { bestCorr = corr; bestLag = lag }
            }
        }
        guard bestLag > 0, bestCorr > 0 else { return nil }
        return 44100.0 / Double(bestLag)
    }

    private func appendToRing(_ samples: UnsafePointer<Float>, count: Int, sampleRate: Double) {
        audioLock.lock()
        defer { audioLock.unlock() }

        if audioRing.isEmpty {
            audioRingRate = sampleRate
            let cap = Int(sampleRate * 8.0)
            audioRing = ContiguousArray<Float>(repeating: 0, count: max(cap, 1))
            audioRingPos = 0
            audioRingFull = false
        }

        let cap = audioRing.count
        for i in 0..<count {
            audioRing[audioRingPos] = samples[i]
            audioRingPos = audioRingPos + 1
            if audioRingPos >= cap {
                audioRingPos = 0
                audioRingFull = true
            }
        }
    }

    func getRecentAudioWav(windowSeconds: Double) -> String? {
        audioLock.lock()
        defer { audioLock.unlock() }
        guard audioRingRate > 0, !audioRing.isEmpty else { return nil }

        let cap       = audioRing.count
        let available = audioRingFull ? cap : audioRingPos
        let take      = min(Int(windowSeconds * audioRingRate), available)
        guard take > 100 else { return nil }

        var samples = [Float](repeating: 0, count: take)
        for i in 0..<take {
            let idx = (audioRingPos - take + i + cap) % cap
            samples[i] = audioRing[idx]
        }
        return pcmToWavBase64(samples: samples, sampleRate: Int(audioRingRate))
    }

    private func pcmToWavBase64(samples: [Float], sampleRate: Int) -> String? {
        let n = samples.count
        var bytes = [UInt8](repeating: 0, count: 44 + n * 2)

        func w4(_ v: UInt32, at i: Int) {
            bytes[i]   = UInt8(v & 0xFF)
            bytes[i+1] = UInt8((v >> 8) & 0xFF)
            bytes[i+2] = UInt8((v >> 16) & 0xFF)
            bytes[i+3] = UInt8((v >> 24) & 0xFF)
        }
        func w2(_ v: UInt16, at i: Int) {
            bytes[i]   = UInt8(v & 0xFF)
            bytes[i+1] = UInt8((v >> 8) & 0xFF)
        }

        for (j, c) in "RIFF".utf8.enumerated() { bytes[j]    = c }
        w4(UInt32(36 + n * 2), at: 4)
        for (j, c) in "WAVE".utf8.enumerated() { bytes[8+j]  = c }
        for (j, c) in "fmt ".utf8.enumerated() { bytes[12+j] = c }
        w4(16, at: 16)
        w2(1,  at: 20)                        // PCM
        w2(1,  at: 22)                        // mono
        w4(UInt32(sampleRate),     at: 24)
        w4(UInt32(sampleRate * 2), at: 28)    // byte rate
        w2(2,  at: 32)                        // block align
        w2(16, at: 34)                        // bits per sample
        for (j, c) in "data".utf8.enumerated() { bytes[36+j] = c }
        w4(UInt32(n * 2), at: 40)

        for i in 0..<n {
            let v = Int16(clamping: Int32(samples[i] * 32767))
            let u = UInt16(bitPattern: v)
            bytes[44 + i*2]     = UInt8(u & 0xFF)
            bytes[44 + i*2 + 1] = UInt8((u >> 8) & 0xFF)
        }

        return Data(bytes).base64EncodedString()
    }

    // MARK: - Frame processing

    private func processFrame(pixelBuffer: CVPixelBuffer) {
        // ── Body pose + hand chirality (Vision) ─────────────────────────────
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .down, options: [:])
        do { try handler.perform([poseRequest, handRequest]) } catch { return }
        guard let observation = poseRequest.results?.first else { return }

        let wantedJoints: [(VNHumanBodyPoseObservation.JointName, String)] = [
            (.leftShoulder,  "leftShoulder"),
            (.rightShoulder, "rightShoulder"),
            (.leftElbow,     "leftElbow"),
            (.rightElbow,    "rightElbow"),
            (.leftWrist,     "leftWrist"),
            (.rightWrist,    "rightWrist"),
            (.neck,          "neck"),
        ]

        var joints: [String: [String: Double]] = [:]
        for (name, key) in wantedJoints {
            guard let pt = try? observation.recognizedPoint(name), pt.confidence > 0 else { continue }
            joints[key] = [
                "x":          Double(pt.location.x),
                "y":          Double(1.0 - pt.location.y),
                "confidence": Double(pt.confidence),
            ]
        }
        guard !joints.isEmpty else { return }

        let wantedHandJoints: [(VNHumanHandPoseObservation.JointName, String)] = [
            (.wrist,     "wrist"),
            (.indexMCP,  "indexMCP"),
            (.middleMCP, "middleMCP"),
            (.ringMCP,   "ringMCP"),
        ]
        var leftHand:  [String: [String: Double]] = [:]
        var rightHand: [String: [String: Double]] = [:]

        for obs in handRequest.results ?? [] {
            var handData: [String: [String: Double]] = [:]
            for (name, key) in wantedHandJoints {
                guard let pt = try? obs.recognizedPoint(name), pt.confidence > 0 else { continue }
                handData[key] = [
                    "x":          Double(pt.location.x),
                    "y":          Double(1.0 - pt.location.y),
                    "confidence": Double(pt.confidence),
                ]
            }
            guard !handData.isEmpty else { continue }
            if obs.chirality == .left { leftHand = handData } else { rightHand = handData }
        }

        // ── World landmarks (MediaPipe) ──────────────────────────────────────
        if let hl = handLandmarker, let mpImage = try? MPImage(pixelBuffer: pixelBuffer) {
            if let result = try? hl.detect(image: mpImage) {
                let wantedIdx: [(Int, String)] = [
                    (0,  "wrist"),
                    (5,  "indexMCP"),
                    (9,  "middleMCP"),
                    (13, "ringMCP"),
                ]
                for (i, landmarks) in result.landmarks.enumerated() {
                    guard i < result.worldLandmarks.count, !landmarks.isEmpty else { continue }
                    let worldLMs = result.worldLandmarks[i]
                    // MediaPipe uses original-frame coords; Vision (.down) inverts x (x_vision = 1 - x_mp).
                    // Flip mpWristX so both coordinate systems match before computing proximity.
                    let mpWristX = 1.0 - Double(landmarks[0].x)
                    let mpWristY = Double(landmarks[0].y)
                    let leftWristX  = leftHand["wrist"]?["x"]  ?? -1
                    let leftWristY  = leftHand["wrist"]?["y"]  ?? -1
                    let rightWristX = rightHand["wrist"]?["x"] ?? -1
                    let rightWristY = rightHand["wrist"]?["y"] ?? -1
                    let distLeft  = leftHand.isEmpty  ? Double.infinity : hypot(mpWristX - leftWristX,  mpWristY - leftWristY)
                    let distRight = rightHand.isEmpty ? Double.infinity : hypot(mpWristX - rightWristX, mpWristY - rightWristY)
                    guard distLeft.isFinite || distRight.isFinite else { continue }
                    let isLeft = distLeft < distRight
                    var targetHand = isLeft ? leftHand : rightHand
                    for (idx, key) in wantedIdx {
                        guard idx < landmarks.count, idx < worldLMs.count else { continue }
                        if var jd = targetHand[key] {
                            let wlm = worldLMs[idx]
                            jd["wx"] = Double(wlm.x)
                            jd["wy"] = Double(wlm.y)
                            jd["wz"] = Double(wlm.z)
                            targetHand[key] = jd
                        }
                    }
                    if isLeft { leftHand = targetHand } else { rightHand = targetHand }
                }
            }
        }

        // ── Pose world landmarks (MediaPipe, when useMpPose enabled) ────────────
        // Enriches each body joint with wx/wy/wz (metres, camera-relative).
        // MP Pose landmark indices: 11=leftShoulder, 12=rightShoulder,
        // 13=leftElbow, 14=rightElbow, 15=leftWrist, 16=rightWrist.
        if let pl = poseLandmarker, let mpPoseImage = try? MPImage(pixelBuffer: pixelBuffer) {
            if let result = try? pl.detect(image: mpPoseImage),
               let worldLMs = result.worldLandmarks.first,
               let normLMs  = result.landmarks.first {
                let poseMapping: [(Int, String)] = [
                    (11, "leftShoulder"),
                    (12, "rightShoulder"),
                    (13, "leftElbow"),
                    (14, "rightElbow"),
                    (15, "leftWrist"),
                    (16, "rightWrist"),
                ]
                for (idx, key) in poseMapping {
                    guard idx < worldLMs.count else { continue }
                    let wlm = worldLMs[idx]
                    if var jd = joints[key] {
                        jd["wx"] = Double(wlm.x)
                        jd["wy"] = Double(wlm.y)
                        jd["wz"] = Double(wlm.z)
                        joints[key] = jd
                    }
                }
                // Finger tips not available from Vision — extract from MP Pose.
                // 17=leftPinkyTip, 19=leftIndexTip (body-global frame, same as body joints above).
                let fingerMapping: [(Int, String)] = [
                    (17, "leftPinkyTip"),
                    (19, "leftIndexTip"),
                ]
                for (idx, key) in fingerMapping {
                    guard idx < worldLMs.count, idx < normLMs.count else { continue }
                    let wlm = worldLMs[idx]
                    let nlm = normLMs[idx]
                    joints[key] = [
                        "x":          1.0 - Double(nlm.x),
                        "y":          Double(nlm.y),
                        "confidence": 1.0,
                        "wx":         Double(wlm.x),
                        "wy":         Double(wlm.y),
                        "wz":         Double(wlm.z),
                    ]
                }
            }
        }

        var payload: [String: Any] = ["joints": joints]
        if !leftHand.isEmpty  { payload["leftHand"]  = leftHand  }
        if !rightHand.isEmpty { payload["rightHand"] = rightHand }

        // ── Bow detection (~10 fps) ──────────────────────────────────────────
        // Runs synchronously on frameQueue — inference takes ~100 ms, so frames
        // that include bow detection naturally throttle to ~7–8 fps for those
        // calls. Frames between bow inferences run at the full 15 fps pose rate.
        let nowBow = CACurrentMediaTime()
        if nowBow - lastBowTime >= bowInterval,
           let detector = BowDetector.shared {
            lastBowTime = nowBow
            let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
            if let cgImage = bowCIContext.createCGImage(ciImage, from: ciImage.extent),
               let bow = detector.detect(in: cgImage) {
                payload["bowTip"]     = ["x": Double(bow.tipX),     "y": Double(bow.tipY),
                                         "visible": bow.tipVisible]
                payload["bowFrog"]    = ["x": Double(bow.frogX),    "y": Double(bow.frogY),
                                         "visible": bow.frogVisible]
                payload["bowContact"] = ["x": Double(bow.contactX), "y": Double(bow.contactY),
                                         "visible": bow.contactVisible]
                payload["bowBox"]     = ["x1": Double(bow.boxX1), "y1": Double(bow.boxY1),
                                         "x2": Double(bow.boxX2), "y2": Double(bow.boxY2)]
                payload["bowConfidence"] = Double(bow.confidence)
            }
        }

        DispatchQueue.main.async { self.onPose(payload) }
    }

    // MARK: - AVCaptureFileOutputRecordingDelegate

    public func fileOutput(_ output: AVCaptureFileOutput,
                           didFinishRecordingTo outputFileURL: URL,
                           from connections: [AVCaptureConnection],
                           error: Error?) {
        if let err = error {
            let ok = (err as NSError).userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool == true
            if ok {
                onRecordingFinished(["uri": outputFileURL.absoluteString])
            } else {
                onRecordingFinished(["error": err.localizedDescription])
            }
        } else {
            onRecordingFinished(["uri": outputFileURL.absoluteString])
        }
    }

    // MARK: - Cleanup

    deinit { session.stopRunning() }
}
