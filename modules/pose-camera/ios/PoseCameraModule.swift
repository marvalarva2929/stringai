import ExpoModulesCore
import AVFoundation
import Vision
import Photos

public class PoseCameraModule: Module {

    public func definition() -> ModuleDefinition {
        Name("PoseCamera")

        AsyncFunction("startRecording") { (promise: Promise) in
            DispatchQueue.main.async {
                PoseCameraView.current?.startRecording()
                promise.resolve()
            }
        }

        AsyncFunction("stopRecording") { (promise: Promise) in
            DispatchQueue.main.async {
                PoseCameraView.current?.stopRecording()
                promise.resolve()
            }
        }

        // Samples an existing video file at 2 fps, runs Apple Vision pose + hands on each
        // frame, and returns an array of frame dicts in the same format as onPose events
        // (with an added "timestamp" field in seconds). Used for the uploaded-video path
        // so the post-session scoring pipeline receives real keypoints instead of mock data.
        AsyncFunction("analyzeVideo") { (videoUri: String, promise: Promise) in
            if videoUri.hasPrefix("ph://") || videoUri.hasPrefix("assets-library://") {
                self.analyzePhotosVideo(uri: videoUri, promise: promise)
            } else {
                let url: URL
                if videoUri.hasPrefix("file://") {
                    guard let u = URL(string: videoUri) else {
                        promise.reject("INVALID_URI", "Cannot parse URI: \(videoUri)")
                        return
                    }
                    url = u
                } else {
                    url = URL(fileURLWithPath: videoUri)
                }
                DispatchQueue.global(qos: .userInitiated).async {
                    self.analyzeVideoFrames(from: AVURLAsset(url: url), promise: promise)
                }
            }
        }

        View(PoseCameraView.self) {
            Events("onPose", "onRecordingFinished", "onCameraReady")
        }
    }

    // MARK: - Photos library URI (ph://)

    private func analyzePhotosVideo(uri: String, promise: Promise) {
        let identifier = uri
            .replacingOccurrences(of: "ph://", with: "")
            .components(separatedBy: "?").first ?? ""
        let results = PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil)
        guard let phAsset = results.firstObject else {
            promise.reject("PH_NOT_FOUND", "PHAsset not found for: \(identifier)")
            return
        }
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        PHImageManager.default().requestAVAsset(forVideo: phAsset, options: options) { avAsset, _, _ in
            guard let avAsset = avAsset else {
                promise.reject("PH_LOAD_FAILED", "Could not load AVAsset from Photos library")
                return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                self.analyzeVideoFrames(from: avAsset, promise: promise)
            }
        }
    }

    // MARK: - Core frame analysis

    private func analyzeVideoFrames(from asset: AVAsset, promise: Promise) {
        let duration = asset.duration.seconds
        guard duration > 0 else {
            promise.reject("INVALID_DURATION", "Could not determine video duration")
            return
        }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        // Allow up to 0.5s tolerance so AVAssetImageGenerator can seek quickly.
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter  = CMTime(seconds: 0.5, preferredTimescale: 600)

        let poseReq = VNDetectHumanBodyPoseRequest()
        let handReq = VNDetectHumanHandPoseRequest()
        handReq.maximumHandCount = 2

        let wantedJoints: [(VNHumanBodyPoseObservation.JointName, String)] = [
            (.leftShoulder,  "leftShoulder"),
            (.rightShoulder, "rightShoulder"),
            (.leftElbow,     "leftElbow"),
            (.rightElbow,    "rightElbow"),
            (.leftWrist,     "leftWrist"),
            (.rightWrist,    "rightWrist"),
            (.neck,          "neck"),
        ]
        let wantedHandJoints: [(VNHumanHandPoseObservation.JointName, String)] = [
            (.wrist,     "wrist"),
            (.indexMCP,  "indexMCP"),
            (.middleMCP, "middleMCP"),
            (.ringMCP,   "ringMCP"),
        ]

        var frames: [[String: Any]] = []
        var t = 0.0
        let step = 0.1  // 10 fps — matches live-recording capture rate

        while t < duration {
            let cmTime = CMTime(seconds: t, preferredTimescale: 600)
            var actual = CMTime.zero
            guard let image = try? generator.copyCGImage(at: cmTime, actualTime: &actual) else {
                t += step
                continue
            }

            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            guard (try? handler.perform([poseReq, handReq])) != nil,
                  let obs = poseReq.results?.first else {
                t += step
                continue
            }

            var joints: [String: [String: Double]] = [:]
            for (name, key) in wantedJoints {
                guard let pt = try? obs.recognizedPoint(name), pt.confidence > 0.3 else { continue }
                joints[key] = [
                    "x":          Double(pt.location.x),
                    "y":          Double(1.0 - pt.location.y),
                    "confidence": Double(pt.confidence),
                ]
            }
            guard !joints.isEmpty else {
                t += step
                continue
            }

            var leftHand:  [String: [String: Double]] = [:]
            var rightHand: [String: [String: Double]] = [:]
            for handObs in handReq.results ?? [] {
                var handData: [String: [String: Double]] = [:]
                for (name, key) in wantedHandJoints {
                    guard let pt = try? handObs.recognizedPoint(name), pt.confidence > 0.4 else { continue }
                    handData[key] = [
                        "x":          Double(pt.location.x),
                        "y":          Double(1.0 - pt.location.y),
                        "confidence": Double(pt.confidence),
                    ]
                }
                guard !handData.isEmpty else { continue }
                if handObs.chirality == .left { leftHand = handData } else { rightHand = handData }
            }

            var payload: [String: Any] = ["timestamp": actual.seconds, "joints": joints]
            if !leftHand.isEmpty  { payload["leftHand"]  = leftHand  }
            if !rightHand.isEmpty { payload["rightHand"] = rightHand }
            frames.append(payload)

            t += step
        }

        promise.resolve(frames)
    }
}
