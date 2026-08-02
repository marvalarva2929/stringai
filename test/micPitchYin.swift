import Foundation
import Accelerate

// Verifies the YIN detector that ships in the tuner.
//
// This compiles modules/mic-pitch/ios/YinDetector.swift directly (see the `test:micpitch`
// npm script) rather than a copy, so it cannot drift from the shipped code.
//
//   npm run test:micpitch

let SR = 48000.0
let W = 2048

let detector = YinDetector()

// ─────────────────────────────────────────────────────────────
// Signal generators
// ─────────────────────────────────────────────────────────────

func sine(_ f: Double, amp: Double = 0.3) -> [Float] {
  (0..<W).map { Float(amp * sin(2 * .pi * f * Double($0) / SR)) }
}

/// Bowed-string-ish harmonic stack. `weakFundamental` models the case that classically
/// tricks autocorrelation into reporting an octave down.
func violinLike(_ f: Double, amp: Double = 0.3, weakFundamental: Bool = false) -> [Float] {
  let partials: [Double] = weakFundamental
    ? [0.10, 1.00, 0.80, 0.60, 0.45, 0.30, 0.20, 0.12]
    : [1.00, 0.70, 0.50, 0.35, 0.25, 0.18, 0.12, 0.08]
  return (0..<W).map { n in
    var s = 0.0
    for (i, a) in partials.enumerated() {
      let h = Double(i + 1)
      s += a * sin(2 * .pi * f * h * Double(n) / SR + Double(i) * 0.7)
    }
    return Float(amp * s / partials.reduce(0, +))
  }
}

func noiseOnly(_ amp: Double, seed s0: UInt64) -> [Float] {
  var seed = s0
  return (0..<W).map { _ in
    seed = seed &* 6364136223846793005 &+ 1442695040888963407
    let u = Double(seed >> 11) / Double(1 << 53) * 2 - 1
    return Float(amp * u)
  }
}

func addNoise(_ x: [Float], snrDb: Double) -> [Float] {
  var rms: Float = 0
  vDSP_rmsqv(x, 1, &rms, vDSP_Length(x.count))
  let noiseAmp = Double(rms) / pow(10, snrDb / 20)
  var seed: UInt64 = 12345
  return x.map { v in
    seed = seed &* 6364136223846793005 &+ 1442695040888963407
    let u = Double(seed >> 11) / Double(1 << 53) * 2 - 1
    return v + Float(noiseAmp * u)
  }
}

func cents(_ measured: Double, _ expected: Double) -> Double {
  1200 * log2(measured / expected)
}

// ─────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────

var failures = 0
var checks = 0

func check(_ name: String, _ signal: [Float], expected: Double, tolCents: Double) {
  checks += 1
  let r = detector.analyze(signal, sampleRate: SR)
  guard r.voiced else {
    print("  ✘ \(name): UNVOICED (clarity \(String(format: "%.2f", r.clarity)))")
    failures += 1
    return
  }
  let err = cents(r.hz, expected)
  let ok = abs(err) <= tolCents
  if !ok { failures += 1 }
  print(String(format: "  %@ %-30@ %8.2f Hz  (exp %7.2f)  err %+6.2f¢   clarity %.2f",
               ok ? "✓" : "✘", name as NSString, r.hz, expected, err, r.clarity))
}

func checkUnvoiced(_ name: String, _ signal: [Float]) {
  checks += 1
  let r = detector.analyze(signal, sampleRate: SR)
  let ok = !r.voiced
  if !ok { failures += 1 }
  print("  \(ok ? "✓" : "✘") \(name): voiced=\(r.voiced) (expected unvoiced)")
}

// ─────────────────────────────────────────────────────────────
// Cases
// ─────────────────────────────────────────────────────────────

@main
struct MicPitchYinTests {
  static func main() {
    print("\n── Open strings, pure sine (±1¢) ──")
    check("G3 open", sine(196.00), expected: 196.00, tolCents: 1)
    check("D4 open", sine(293.66), expected: 293.66, tolCents: 1)
    check("A4 open", sine(440.00), expected: 440.00, tolCents: 1)
    check("E5 open", sine(659.25), expected: 659.25, tolCents: 1)

    print("\n── Open strings, violin-like harmonics (±2¢) ──")
    check("G3 harmonic-rich", violinLike(196.00), expected: 196.00, tolCents: 2)
    check("D4 harmonic-rich", violinLike(293.66), expected: 293.66, tolCents: 2)
    check("A4 harmonic-rich", violinLike(440.00), expected: 440.00, tolCents: 2)
    check("E5 harmonic-rich", violinLike(659.25), expected: 659.25, tolCents: 2)

    print("\n── Weak fundamental — the octave-error trap (±2¢) ──")
    check("G3 weak fundamental", violinLike(196.00, weakFundamental: true), expected: 196.00, tolCents: 2)
    check("A4 weak fundamental", violinLike(440.00, weakFundamental: true), expected: 440.00, tolCents: 2)
    check("E5 weak fundamental", violinLike(659.25, weakFundamental: true), expected: 659.25, tolCents: 2)

    print("\n── Detuned: does the needle read the right cents? (±1.5¢) ──")
    for offset in [-40.0, -25.0, -12.0, -5.0, 5.0, 12.0, 25.0, 40.0] {
      let f = 440.0 * pow(2, offset / 1200)
      check(String(format: "A4 %+.0f¢", offset), violinLike(f), expected: f, tolCents: 1.5)
    }

    print("\n── Range extremes (±2¢) ──")
    check("C4 middle", violinLike(261.63), expected: 261.63, tolCents: 2)
    check("B5 high position", violinLike(987.77), expected: 987.77, tolCents: 2)

    print("\n── Noise robustness, A4 harmonic-rich (±3¢) ──")
    check("SNR 30dB", addNoise(violinLike(440), snrDb: 30), expected: 440, tolCents: 3)
    check("SNR 20dB", addNoise(violinLike(440), snrDb: 20), expected: 440, tolCents: 3)
    check("SNR 10dB", addNoise(violinLike(440), snrDb: 10), expected: 440, tolCents: 3)

    print("\n── Silence must not produce a note ──")
    checkUnvoiced("digital silence", [Float](repeating: 0, count: W))
    checkUnvoiced("below RMS gate", sine(440, amp: 0.001))

    print("\n── Quiet but real playing must still register (±2¢) ──")
    check("A4 at amp 0.05", violinLike(440, amp: 0.05), expected: 440, tolCents: 2)
    check("A4 at amp 0.02", violinLike(440, amp: 0.02), expected: 440, tolCents: 2)
    check("A4 at amp 0.01", violinLike(440, amp: 0.01), expected: 440, tolCents: 2)

    // The RMS gate is deliberately low, so clarity alone has to reject room tone. If any of
    // these read as a note, the tuner shows a phantom pitch when nobody is playing.
    print("\n── Broadband noise rejected on clarity alone ──")
    checkUnvoiced("white noise amp 0.05", noiseOnly(0.05, seed: 999))
    checkUnvoiced("white noise amp 0.20", noiseOnly(0.20, seed: 4242))
    checkUnvoiced("white noise amp 0.50", noiseOnly(0.50, seed: 77))

    print("\n────────────────────────────────────────")
    print(failures == 0 ? "✅ ALL \(checks) CHECKS PASSED" : "❌ \(failures)/\(checks) CHECKS FAILED")
    print("────────────────────────────────────────\n")
    exit(failures == 0 ? 0 : 1)
  }
}
