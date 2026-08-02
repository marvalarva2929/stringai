import CoreML
import Vision
import CoreImage
import UIKit

// MARK: - Output structs

/// One detected box in normalized frame coords [0,1], top-left origin (y grows
/// downward) — the SAME convention as the pose joints emitted by
/// PoseCameraModule (which flips Vision's bottom-left origin via y = 1 − vy).
struct DetectedBox {
    let x1: Float; let y1: Float
    let x2: Float; let y2: Float
    let confidence: Float
}

struct BowDetection {
    // Each class is reported independently against its own threshold, so the
    // violin keeps updating when the bow is off-frame (and vice versa). A
    // detection is returned when at least one class clears its bar.
    let bow: DetectedBox?
    let violin: DetectedBox?
}

// MARK: - BowDetector

/// Runs the 2-class YOLOv8 *detect* CoreML model (class 0 = bow, class 1 = violin)
/// on a single CGImage and returns the best box per class.
///
/// No keypoints: tip/frog/contact are derived geometrically on the JS side
/// (src/lib/bowBoxGeometry.ts) from the two boxes plus pose wrist landmarks —
/// frog = bow-box corner nearest the right wrist, tip = opposite corner,
/// contact = intersection of the bow diagonal with the violin-box diagonal.
///
/// Model file: bow_detector.mlpackage (trained by ml/cloud/train_detect.py on
/// LocateAnything auto-labels, exported by ml/export_coreml.py).
///
/// Because only the single best box per class is needed, no NMS is required —
/// the parser simply takes the argmax per class. Both the pipeline-NMS export
/// (nms=True → "confidence"/"coordinates" outputs) and the raw export
/// (output0) are supported.
class BowDetector {
    static let shared: BowDetector? = BowDetector()

    private let model:     MLModel
    private let inputSize: CGSize = CGSize(width: 640, height: 640)

    /// Class ids — must match ml/cloud/data_detect.yaml names: ['bow', 'violin']
    private static let bowClass    = 0
    private static let violinClass = 1
    private static let numClasses  = 2

    // Minimum confidence for reporting a box. A frame without a bow ≥ this
    // threshold returns nil. Violin gets its own, much lower bar — its
    // confidence is calibrated far below the bow's (LocateAnything auto-labels
    // for the violin are looser than the bow's, so the model learned to hedge:
    // mAP50/recall on held-out data are close to the bow's — 0.72/0.75 vs
    // 0.87/0.85 — but raw confidence rarely clears 0.25). Using the bow's
    // threshold for both was hiding real, correctly-localized violin boxes.
    static let confidenceThreshold: Float = 0.40
    // TEMP: lowered from 0.15 to 0.05 to unblock violin-feature testing — this
    // surfaces any violin box the model emits above the baked NMS floor (0.10 →
    // effectively 0.10 is the real floor, since candidates below it are dropped
    // inside CoreML). Raise back to a calibrated value once verified.
    static let violinConfidenceThreshold: Float = 0.05

    private init?() {
        // The model file is compiled at build time from bow_detector.mlpackage.
        // If the file isn't present yet (pre-training), this init returns nil —
        // all calls to detect() safely return nil.
        guard let url = Bundle.main.url(forResource: "bow_detector", withExtension: "mlmodelc") else {
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

    /// Detect the bow and violin boxes in a video frame.
    ///
    /// - Parameter image: A CGImage at any resolution (letterboxed internally to 640×640).
    /// - Returns: BowDetection with boxes in normalized top-left-origin frame
    ///            coords, or nil if no bow was detected above the confidence threshold.
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

    /// Per-class best candidate accumulator (in letterbox pixel space, xyxy).
    private struct Candidate {
        var conf: Float = 0
        var x1: Float = 0; var y1: Float = 0; var x2: Float = 0; var y2: Float = 0
    }

    private func parseOutput(
        _ output:       MLFeatureProvider,
        scale:          CGFloat,
        padX:           CGFloat,
        padY:           CGFloat,
        originalWidth:  CGFloat,
        originalHeight: CGFloat
    ) -> BowDetection? {
        var best = [Candidate(), Candidate()]   // [bow, violin]

        if output.featureNames.contains("confidence"),
           output.featureNames.contains("coordinates"),
           let conf = output.featureValue(for: "confidence")?.multiArrayValue,
           let coords = output.featureValue(for: "coordinates")?.multiArrayValue {
            // Pipeline-NMS export (nms=True): confidence [N, nc], coordinates [N, 4]
            // with normalized (cx, cy, w, h) relative to the 640×640 input.
            accumulatePipeline(conf: conf, coords: coords, into: &best)
        } else if let key = output.featureNames.first(where: { $0.hasPrefix("output") })
                        ?? output.featureNames.first,
                  let arr = output.featureValue(for: key)?.multiArrayValue {
            let shape = arr.shape.map { $0.intValue }
            if shape.count == 3 && shape[0] == 1 && shape[1] == 4 + BowDetector.numClasses {
                // Raw export: [1, 4+nc, N] — rows cx,cy,w,h,conf_bow,conf_violin
                // in letterbox pixels. Argmax per class replaces NMS.
                accumulateRawChannelFirst(arr, anchors: shape[2], into: &best)
            } else if shape.count == 3 && shape[0] == 1 && shape[2] == 6 && shape[1] > 6 {
                // NMS'd row export: [1, N, 6] — rows x1,y1,x2,y2,conf,cls
                // in letterbox pixels.
                accumulateNmsRows(arr, rows: shape[1], into: &best)
            } else {
                print("[BowDetector] Unexpected output shape: \(shape). Update parsing logic.")
                return nil
            }
        } else {
            print("[BowDetector] No parsable output found. Keys: \(output.featureNames)")
            return nil
        }

        func toBox(_ c: Candidate) -> DetectedBox {
            let (nx1, ny1) = fromLetterbox(c.x1, c.y1, scale: scale, padX: padX, padY: padY,
                                           W: originalWidth, H: originalHeight)
            let (nx2, ny2) = fromLetterbox(c.x2, c.y2, scale: scale, padX: padX, padY: padY,
                                           W: originalWidth, H: originalHeight)
            return DetectedBox(x1: min(nx1, nx2), y1: min(ny1, ny2),
                               x2: max(nx1, nx2), y2: max(ny1, ny2),
                               confidence: c.conf)
        }

        let bowCand    = best[BowDetector.bowClass]
        let violinCand = best[BowDetector.violinClass]
        let bow    = bowCand.conf    >= BowDetector.confidenceThreshold       ? toBox(bowCand)    : nil
        let violin = violinCand.conf >= BowDetector.violinConfidenceThreshold ? toBox(violinCand) : nil
        guard bow != nil || violin != nil else { return nil }
        return BowDetection(bow: bow, violin: violin)
    }

    /// Pipeline-NMS layout: confidence [N, nc], coordinates [N, 4] normalized cxcywh.
    private func accumulatePipeline(conf: MLMultiArray, coords: MLMultiArray,
                                    into best: inout [Candidate]) {
        let confShape = conf.shape.map { $0.intValue }
        guard confShape.count == 2, confShape[1] >= BowDetector.numClasses else {
            print("[BowDetector] Unexpected confidence shape: \(confShape)")
            return
        }
        let n = confShape[0]
        let side = Float(inputSize.width)
        for i in 0..<n {
            let cx = coords[[i, 0] as [NSNumber]].floatValue * side
            let cy = coords[[i, 1] as [NSNumber]].floatValue * side
            let w  = coords[[i, 2] as [NSNumber]].floatValue * side
            let h  = coords[[i, 3] as [NSNumber]].floatValue * side
            for cls in 0..<BowDetector.numClasses {
                let c = conf[[i, cls] as [NSNumber]].floatValue
                if c > best[cls].conf {
                    best[cls] = Candidate(conf: c,
                                          x1: cx - w / 2, y1: cy - h / 2,
                                          x2: cx + w / 2, y2: cy + h / 2)
                }
            }
        }
    }

    /// Raw layout: [1, 4+nc, N] — cx,cy,w,h then one confidence row per class.
    private func accumulateRawChannelFirst(_ arr: MLMultiArray, anchors: Int,
                                           into best: inout [Candidate]) {
        for j in 0..<anchors {
            for cls in 0..<BowDetector.numClasses {
                let c = arr[[0, 4 + cls, j] as [NSNumber]].floatValue
                guard c > best[cls].conf else { continue }
                let cx = arr[[0, 0, j] as [NSNumber]].floatValue
                let cy = arr[[0, 1, j] as [NSNumber]].floatValue
                let w  = arr[[0, 2, j] as [NSNumber]].floatValue
                let h  = arr[[0, 3, j] as [NSNumber]].floatValue
                best[cls] = Candidate(conf: c,
                                      x1: cx - w / 2, y1: cy - h / 2,
                                      x2: cx + w / 2, y2: cy + h / 2)
            }
        }
    }

    /// NMS'd row layout: [1, N, 6] — x1,y1,x2,y2,conf,cls per row.
    private func accumulateNmsRows(_ arr: MLMultiArray, rows: Int,
                                   into best: inout [Candidate]) {
        for i in 0..<rows {
            let c = arr[[0, i, 4] as [NSNumber]].floatValue
            let cls = Int(arr[[0, i, 5] as [NSNumber]].floatValue.rounded())
            guard cls >= 0, cls < BowDetector.numClasses, c > best[cls].conf else { continue }
            best[cls] = Candidate(conf: c,
                                  x1: arr[[0, i, 0] as [NSNumber]].floatValue,
                                  y1: arr[[0, i, 1] as [NSNumber]].floatValue,
                                  x2: arr[[0, i, 2] as [NSNumber]].floatValue,
                                  y2: arr[[0, i, 3] as [NSNumber]].floatValue)
        }
    }

    // MARK: - Coordinate conversion

    /// Convert a point from letterbox 640×640 pixel space back to normalized
    /// original-frame coords, TOP-LEFT origin (y grows downward).
    ///
    /// Image pixel space is already top-left origin, so no y-flip is applied —
    /// this matches the pose joints, which PoseCameraModule flips out of
    /// Vision's bottom-left convention with y = 1 − vy. (The old keypoint
    /// detector flipped y here, which put bow coords in the OPPOSITE space
    /// from the joints — do not reintroduce that flip.)
    private func fromLetterbox(
        _ px: Float, _ py: Float,
        scale: CGFloat, padX: CGFloat, padY: CGFloat,
        W: CGFloat, H: CGFloat
    ) -> (Float, Float) {
        let origX = (CGFloat(px) - padX) / scale
        let origY = (CGFloat(py) - padY) / scale
        let nx = Float(max(0, min(1, origX / W)))
        let ny = Float(max(0, min(1, origY / H)))
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
