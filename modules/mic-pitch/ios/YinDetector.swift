import Foundation
import Accelerate

/// One pitch estimate over a single analysis window.
struct PitchEstimate {
  let hz: Double
  let clarity: Float
  let rms: Float
  let voiced: Bool

  static func unvoiced(rms: Float, hz: Double = 0, clarity: Float = 0) -> PitchEstimate {
    PitchEstimate(hz: hz, clarity: clarity, rms: rms, voiced: false)
  }
}

/**
 * YIN pitch detector (de Cheveigné & Kawahara 2002), steps 1–5.
 *
 * Deliberately free of ExpoModulesCore so it can be compiled and unit-tested standalone —
 * see `test/micPitchYin.swift`, which compiles *this* file rather than a copy of it.
 */
struct YinDetector {

  /// Open G is 196Hz; the floor leaves room for a badly flat G without octave-halving.
  let minFreq: Double
  /// Open E is 659Hz; the ceiling covers high-position playing on the E string.
  let maxFreq: Double
  /// Standard YIN absolute threshold — below this, d'(tau) counts as a period.
  let threshold: Float
  /// Clarity, not amplitude, is what separates a note from room tone: broadband noise scores
  /// far below this even when it's loud. This gate does the real work of rejecting non-notes.
  let clarityGate: Float
  /// Only meant to skip the cost of YIN on true silence. Deliberately low — raising it to
  /// something like 0.008 starts rejecting genuinely quiet playing, which the clarity gate
  /// would have accepted correctly.
  let rmsGate: Float

  init(
    minFreq: Double = 55.0,
    maxFreq: Double = 1600.0,
    threshold: Float = 0.15,
    clarityGate: Float = 0.55,
    rmsGate: Float = 0.003
  ) {
    self.minFreq = minFreq
    self.maxFreq = maxFreq
    self.threshold = threshold
    self.clarityGate = clarityGate
    self.rmsGate = rmsGate
  }

  /**
   * The difference function is expanded to reuse an autocorrelation:
   *   d(tau) = sum (x[j] - x[j+tau])^2  =  p(0) + p(tau) - 2*r(tau)
   * so the inner loop is a single vDSP_dotpr instead of a hand-rolled subtract-square.
   *
   * Parabolic interpolation on the winning tau is not optional: at 48kHz an open E (659Hz)
   * sits at tau≈73, where one whole sample of error is ~24 cents — visibly wrong on a tuner.
   */
  func analyze(_ x: [Float], sampleRate: Double) -> PitchEstimate {
    let W = x.count
    let N = W / 2  // integration window; tau can then run to N-1 without reading past the end

    var rms: Float = 0
    vDSP_rmsqv(x, 1, &rms, vDSP_Length(W))

    guard rms >= rmsGate else { return .unvoiced(rms: rms) }

    let tauMin = max(2, Int(sampleRate / maxFreq))
    let tauMax = min(N - 1, Int(sampleRate / minFreq))
    guard tauMax > tauMin + 2 else { return .unvoiced(rms: rms) }

    // ── Step 1–2: difference function ────────────────────────────────────
    var d = [Float](repeating: 0, count: tauMax + 1)

    var power0: Float = 0
    vDSP_svesq(x, 1, &power0, vDSP_Length(N))

    x.withUnsafeBufferPointer { xp in
      guard let base = xp.baseAddress else { return }
      // p(tau) slides: drop the sample leaving the window, add the one entering it.
      var powerTau = power0
      for tau in 1...tauMax {
        let leaving = base[tau - 1]
        let entering = base[tau - 1 + N]
        powerTau += entering * entering - leaving * leaving

        var r: Float = 0
        vDSP_dotpr(base, 1, base + tau, 1, &r, vDSP_Length(N))
        d[tau] = power0 + powerTau - 2 * r
      }
    }

    // ── Step 3: cumulative mean normalized difference ────────────────────
    // This is what suppresses the trivial tau=0 minimum and most octave errors.
    var dPrime = [Float](repeating: 1, count: tauMax + 1)
    var runningSum: Float = 0
    for tau in 1...tauMax {
      runningSum += d[tau]
      dPrime[tau] = runningSum > 1e-9 ? d[tau] * Float(tau) / runningSum : 1
    }

    // ── Step 4: absolute threshold ───────────────────────────────────────
    // Take the *first* dip below threshold, not the global minimum — the global min is
    // frequently an octave below the true pitch on a harmonic-rich bowed string.
    var bestTau = -1
    var tau = tauMin
    while tau <= tauMax {
      if dPrime[tau] < threshold {
        while tau + 1 <= tauMax && dPrime[tau + 1] < dPrime[tau] { tau += 1 }
        bestTau = tau
        break
      }
      tau += 1
    }

    if bestTau < 0 {
      var minVal = Float.greatestFiniteMagnitude
      for t in tauMin...tauMax where dPrime[t] < minVal {
        minVal = dPrime[t]
        bestTau = t
      }
    }

    guard bestTau > 0 else { return .unvoiced(rms: rms) }

    let clarity = max(0, min(1, 1 - dPrime[bestTau]))

    // ── Step 5: parabolic interpolation for sub-sample tau ───────────────
    var refinedTau = Float(bestTau)
    if bestTau > tauMin && bestTau < tauMax {
      let s0 = dPrime[bestTau - 1]
      let s1 = dPrime[bestTau]
      let s2 = dPrime[bestTau + 1]
      let denom = 2 * s1 - s2 - s0
      if abs(denom) > 1e-9 {
        let shift = (s2 - s0) / (2 * denom)
        if abs(shift) <= 1 { refinedTau = Float(bestTau) + shift }
      }
    }

    guard refinedTau > 0 else { return .unvoiced(rms: rms) }

    let hz = sampleRate / Double(refinedTau)
    guard hz >= minFreq, hz <= maxFreq, clarity >= clarityGate else {
      return .unvoiced(rms: rms, hz: hz, clarity: clarity)
    }

    return PitchEstimate(hz: hz, clarity: clarity, rms: rms, voiced: true)
  }
}
