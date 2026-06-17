import ExpoModulesCore
import AVFoundation
import Vision
import MediaPipeTasksVision

public class PoseCameraView: ExpoView,
                              AVCaptureVideoDataOutputSampleBufferDelegate,
                              AVCaptureFileOutputRecordingDelegate {

    // MARK: - Events
    let onPose              = EventDispatcher()
    let onRecordingFinished = EventDispatcher()
    let onCameraReady       = EventDispatcher()

    // MARK: - AV stack
    private let session     = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let movieOutput = AVCaptureMovieFileOutput()
    private let frameOutput = AVCaptureVideoDataOutput()
    private let frameQueue  = DispatchQueue(label: "pose.frames", qos: .userInteractive)

    // MARK: - Vision (body pose + hand chirality/image-coords)
    private let poseRequest = VNDetectHumanBodyPoseRequest()
    private let handRequest: VNDetectHumanHandPoseRequest = {
        let r = VNDetectHumanHandPoseRequest()
        r.maximumHandCount = 2
        return r
    }()
    private var lastPoseTime: Double = 0
    private let poseInterval: Double = 1.0 / 15.0

    // MARK: - MediaPipe (world landmarks for palm orientation)
    private var handLandmarker: HandLandmarker?

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

        if session.canAddOutput(movieOutput) {
            session.addOutput(movieOutput)
            if let conn = movieOutput.connection(with: .video) {
                if conn.isVideoOrientationSupported { conn.videoOrientation = .landscapeRight }
                if conn.isVideoMirroringSupported   { conn.isVideoMirrored = true }
            }
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

    // MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

    public func captureOutput(_ output: AVCaptureOutput,
                               didOutput sampleBuffer: CMSampleBuffer,
                               from connection: AVCaptureConnection) {
        let now = CACurrentMediaTime()
        guard now - lastPoseTime >= poseInterval else { return }
        lastPoseTime = now
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        processFrame(pixelBuffer: pixelBuffer)
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

        var payload: [String: Any] = ["joints": joints]
        if !leftHand.isEmpty  { payload["leftHand"]  = leftHand  }
        if !rightHand.isEmpty { payload["rightHand"] = rightHand }

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
