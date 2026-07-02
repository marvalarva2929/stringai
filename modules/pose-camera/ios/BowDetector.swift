import CoreML
import Vision
import CoreImage
import UIKit

// MARK: - Output struct

struct BowDetection {
    let tipX:          Float;  let tipY:          Float;  let tipVisible:     Bool
    let frogX:         Float;  let frogY:         Float;  let frogVisible:    Bool
    let contactX:      Float;  let contactY:      Float;  let contactVisible: Bool
    let confidence:    Float
    // Axis-aligned bounding box in normalized frame coords [0,1], same space as keypoints
    let boxX1: Float;  let boxY1: Float;  let boxX2: Float;  let boxY2: Float
}

// MARK: - BowDetector

/// Runs the YOLOv8n-pose CoreML bow keypoint model on a single CGImage.
/// The model detects 3 keypoints: tip (KP0), frog (KP1), contact point (KP2).
///
/// Model file: bow_detector.mlpackage (placed in modules/pose-camera/ios/ after training).
/// Model is trained with nms=True and int8=True, so NMS is baked in and we get
/// at most max_det (default 300) detections. We take the highest-confidence one.
///
/// Coordinate system: all returned x/y are normalized [0, 1] in the ORIGINAL frame,
/// matching the Vision coordinate system used by the rest of PoseCameraModule.
/// (y=0 = top of frame, matching the flipped Vision output — see PoseCameraModule.swift).
class BowDetector {
    static let shared: BowDetector? = BowDetector()

    private let model:      MLModel
    private let inputSize:  CGSize = CGSize(width: 640, height: 640)

    // Confidence threshold for reporting a detection. Frames below this are nil.
    static let confidenceThreshold: Float = 0.40
    // Keypoint visibility threshold: visibility score from model must exceed this.
    static let visibilityThreshold: Float = 0.50

    private init?() {
        // The model file is compiled at build time from bow_detector.mlpackage.
        // If the file isn't present yet (pre-training), this init returns nil —
        // all calls to detect() safely return nil.
        guard let url = Bundle.main.url(forResource: "bow_detector", withExtension: "mlmodelc") else {
            // Model not yet integrated — expected during development before training.
            return nil
        }
        do {
            let config = MLModelConfiguration()
            if #available(iOS 16.0, *) {
                config.computeUnits = .cpuAndNeuralEngine
            }
            self.model = try MLModel(contentsOf: url, configuration: config)
        } catch {
            print("[BowDetector] Failed to load model: \(error)")
            return nil
        }
    }

    // MARK: - Public API

    /// Detect bow keypoints in a video frame.
    ///
    /// - Parameter image: A CGImage at any resolution (letterboxed internally to 640×640).
    /// - Returns: BowDetection with keypoints in normalized frame coords [0,1],
    ///            or nil if no bow detected above confidence threshold.
    func detect(in image: CGImage) -> BowDetection? {
        let (letterboxed, scale, padX, padY) = letterbox(image: image, to: inputSize)
        guard let pixelBuffer = pixelBuffer(from: letterboxed) else { return nil }

        do {
            let input = try MLDictionaryFeatureProvider(
                dictionary: ["image": MLFeatureValue(pixelBuffer: pixelBuffer)]
            )
            let output = try model.prediction(from: input)
            return parseOutput(output,
                               scale: scale, padX: padX, padY: padY,
                               originalWidth:  CGFloat(image.width),
                               originalHeight: CGFloat(image.height))
        } catch {
            print("[BowDetector] Inference error: \(error)")
            return nil
        }
    }

    // MARK: - Output parsing

    /// Parse the model output MultiArray into a BowDetection.
    ///
    /// YOLOv8-pose CoreML with NMS baked in outputs a MultiArray at key "output0"
    /// with shape [1, N, 14] where each detection row is:
    ///   [x1, y1, x2, y2, conf, tip_x, tip_y, tip_v, frog_x, frog_y, frog_v, cx, cy, cv]
    /// All coordinates are in the letterboxed 640×640 space.
    ///
    /// If the output format differs (e.g., different key name or transposed shape),
    /// this method logs a debug message and returns nil so we can diagnose.
    private func parseOutput(
        _ output:         MLFeatureProvider,
        scale:            CGFloat,
        padX:             CGFloat,
        padY:             CGFloat,
        originalWidth:    CGFloat,
        originalHeight:   CGFloat
    ) -> BowDetection? {
        // Try the standard Ultralytics output key; fall back to scanning all keys.
        let outputKey = output.featureNames.first(where: { $0.hasPrefix("output") })
                     ?? output.featureNames.first

        guard let key = outputKey,
              let featureValue = output.featureValue(for: key),
              let arr = featureValue.multiArrayValue else {
            print("[BowDetector] No MultiArray output found. Keys: \(output.featureNames)")
            return nil
        }

        // Shape: [1, N, 14] — batch=1, up to N detections, 14 values each.
        // Also handle transposed [1, 14, N] from non-NMS export.
        let shape = arr.shape.map { $0.intValue }

        var bestDetection: BowDetection? = nil
        var bestConf: Float = BowDetector.confidenceThreshold

        if shape.count == 3 && shape[0] == 1 {
            let dim1 = shape[1], dim2 = shape[2]

            if dim2 == 14 {
                // [1, N, 14] — standard post-NMS layout
                for i in 0..<dim1 {
                    let conf = arr[[0, i, 4] as [NSNumber]].floatValue
                    guard conf >= bestConf else { continue }
                    let det = extractDetection(arr, row: i, colAxis: 1,
                                               scale: scale, padX: padX, padY: padY,
                                               W: originalWidth, H: originalHeight)
                    if det != nil { bestConf = conf; bestDetection = det }
                }
            } else if dim1 == 14 {
                // [1, 14, N] — pre-NMS transposed layout; take highest-conf column
                for j in 0..<dim2 {
                    let conf = arr[[0, 4, j] as [NSNumber]].floatValue
                    guard conf >= bestConf else { continue }
                    let det = extractDetectionTransposed(arr, col: j,
                                                         scale: scale, padX: padX, padY: padY,
                                                         W: originalWidth, H: originalHeight)
                    if det != nil { bestConf = conf; bestDetection = det }
                }
            } else {
                print("[BowDetector] Unexpected output shape: \(shape). Update parsing logic.")
            }
        } else {
            print("[BowDetector] Unexpected output dimensions: \(shape).")
        }

        return bestDetection
    }

    /// Extract one detection from a [1, N, 14] array at row `i`.
    /// Post-NMS layout: cols 0-3 are x1,y1,x2,y2 in letterbox space.
    private func extractDetection(
        _ arr: MLMultiArray, row: Int, colAxis: Int,
        scale: CGFloat, padX: CGFloat, padY: CGFloat,
        W: CGFloat, H: CGFloat
    ) -> BowDetection? {
        let conf = arr[[0, row, 4] as [NSNumber]].floatValue
        // Bounding box: x1,y1,x2,y2 in letterbox space
        let bx1 = arr[[0, row, 0] as [NSNumber]].floatValue
        let by1 = arr[[0, row, 1] as [NSNumber]].floatValue
        let bx2 = arr[[0, row, 2] as [NSNumber]].floatValue
        let by2 = arr[[0, row, 3] as [NSNumber]].floatValue
        let (nx1, ny1) = fromLetterbox(bx1, by1, scale: scale, padX: padX, padY: padY, W: W, H: H)
        let (nx2, ny2) = fromLetterbox(bx2, by2, scale: scale, padX: padX, padY: padY, W: W, H: H)

        // Keypoints: indices 5-13 (tip: 5-7, frog: 8-10, contact: 11-13)
        func kp(_ kpIdx: Int) -> (Float, Float, Bool) {
            let base = 5 + kpIdx * 3
            let kx = arr[[0, row, base    ] as [NSNumber]].floatValue
            let ky = arr[[0, row, base + 1] as [NSNumber]].floatValue
            let kv = arr[[0, row, base + 2] as [NSNumber]].floatValue
            let (nx, ny) = fromLetterbox(kx, ky, scale: scale, padX: padX, padY: padY, W: W, H: H)
            return (nx, ny, kv >= BowDetector.visibilityThreshold)
        }

        let (tx, ty, tv) = kp(0)
        let (fx, fy, fv) = kp(1)
        let (cx, cy, cv) = kp(2)

        return BowDetection(
            tipX: tx, tipY: ty, tipVisible: tv,
            frogX: fx, frogY: fy, frogVisible: fv,
            contactX: cx, contactY: cy, contactVisible: cv,
            confidence: conf,
            boxX1: min(nx1, nx2), boxY1: min(ny1, ny2),
            boxX2: max(nx1, nx2), boxY2: max(ny1, ny2)
        )
    }

    /// Extract one detection from a [1, 14, N] array at column `j`.
    /// Pre-NMS (raw YOLO) layout: rows 0-3 are cx,cy,w,h in letterbox space.
    private func extractDetectionTransposed(
        _ arr: MLMultiArray, col: Int,
        scale: CGFloat, padX: CGFloat, padY: CGFloat,
        W: CGFloat, H: CGFloat
    ) -> BowDetection? {
        let conf = arr[[0, 4, col] as [NSNumber]].floatValue

        // Bounding box: cx,cy,w,h → convert to x1,y1,x2,y2
        let bcx = arr[[0, 0, col] as [NSNumber]].floatValue
        let bcy = arr[[0, 1, col] as [NSNumber]].floatValue
        let bw  = arr[[0, 2, col] as [NSNumber]].floatValue
        let bh  = arr[[0, 3, col] as [NSNumber]].floatValue
        let (nx1, ny1) = fromLetterbox(bcx - bw / 2, bcy - bh / 2, scale: scale, padX: padX, padY: padY, W: W, H: H)
        let (nx2, ny2) = fromLetterbox(bcx + bw / 2, bcy + bh / 2, scale: scale, padX: padX, padY: padY, W: W, H: H)

        func kp(_ kpIdx: Int) -> (Float, Float, Bool) {
            let base = 5 + kpIdx * 3
            let kx = arr[[0, base,     col] as [NSNumber]].floatValue
            let ky = arr[[0, base + 1, col] as [NSNumber]].floatValue
            let kv = arr[[0, base + 2, col] as [NSNumber]].floatValue
            let (nx, ny) = fromLetterbox(kx, ky, scale: scale, padX: padX, padY: padY, W: W, H: H)
            return (nx, ny, kv >= BowDetector.visibilityThreshold)
        }

        let (tx, ty, tv) = kp(0)
        let (fx, fy, fv) = kp(1)
        let (cx, cy, cv) = kp(2)

        return BowDetection(
            tipX: tx, tipY: ty, tipVisible: tv,
            frogX: fx, frogY: fy, frogVisible: fv,
            contactX: cx, contactY: cy, contactVisible: cv,
            confidence: conf,
            boxX1: min(nx1, nx2), boxY1: min(ny1, ny2),
            boxX2: max(nx1, nx2), boxY2: max(ny1, ny2)
        )
    }

    // MARK: - Coordinate conversion

    /// Convert a keypoint from letterbox 640×640 space back to normalized original frame coords.
    /// Matches the y-flip convention used by Vision in PoseCameraModule (y=0 = top).
    private func fromLetterbox(
        _ kx: Float, _ ky: Float,
        scale: CGFloat, padX: CGFloat, padY: CGFloat,
        W: CGFloat, H: CGFloat
    ) -> (Float, Float) {
        let origX = (CGFloat(kx) - padX) / scale
        let origY = (CGFloat(ky) - padY) / scale
        // Clamp to [0, 1] and flip y to match Vision coordinate convention
        let nx = Float(max(0, min(1, origX / W)))
        let ny = Float(max(0, min(1, 1.0 - origY / H)))
        return (nx, ny)
    }

    // MARK: - Image preprocessing

    /// Letterbox `image` into a square of `targetSize`, preserving aspect ratio.
    /// Returns the resized CGImage plus the parameters needed to undo the transform.
    ///
    /// - Returns: (letterboxed image, scale, padX in pixels, padY in pixels)
    private func letterbox(image: CGImage, to targetSize: CGSize)
        -> (CGImage, CGFloat, CGFloat, CGFloat)
    {
        let W = CGFloat(image.width)
        let H = CGFloat(image.height)
        let scale = min(targetSize.width / W, targetSize.height / H)
        let newW   = W * scale
        let newH   = H * scale
        let padX   = (targetSize.width  - newW) / 2
        let padY   = (targetSize.height - newH) / 2

        UIGraphicsBeginImageContextWithOptions(targetSize, false, 1.0)
        let ctx = UIGraphicsGetCurrentContext()!
        ctx.setFillColor(UIColor(white: 0.5, alpha: 1).cgColor)
        ctx.fill(CGRect(origin: .zero, size: targetSize))

        let drawRect = CGRect(x: padX, y: padY, width: newW, height: newH)
        // UIKit coordinate system has y flipped — correct for CGImage drawing
        ctx.translateBy(x: 0, y: targetSize.height)
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(image, in: drawRect)

        let result = ctx.makeImage()!
        UIGraphicsEndImageContext()
        return (result, scale, padX, padY)
    }

    /// Convert a CGImage to a CVPixelBuffer (kCVPixelFormatType_32BGRA) for CoreML input.
    private func pixelBuffer(from image: CGImage) -> CVPixelBuffer? {
        let width  = image.width
        let height = image.height
        var pb: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey:       true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                                  kCVPixelFormatType_32BGRA,
                                  attrs as CFDictionary, &pb) == kCVReturnSuccess,
              let pixelBuffer = pb else { return nil }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        let ctx = CGContext(
            data:             CVPixelBufferGetBaseAddress(pixelBuffer),
            width:            width, height: height,
            bitsPerComponent: 8,
            bytesPerRow:      CVPixelBufferGetBytesPerRow(pixelBuffer),
            space:            CGColorSpaceCreateDeviceRGB(),
            bitmapInfo:       CGImageAlphaInfo.noneSkipFirst.rawValue |
                              CGBitmapInfo.byteOrder32Little.rawValue
        )
        ctx?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
        return pixelBuffer
    }
}
