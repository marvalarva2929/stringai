import ExpoModulesCore
import AVFoundation
import Photos

public class VideoAudioExtractorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoAudioExtractor")

    AsyncFunction("extractAudio") { (videoUri: String, promise: Promise) in
      if videoUri.hasPrefix("ph://") || videoUri.hasPrefix("assets-library://") {
        self.extractFromPhotosAsset(uri: videoUri, promise: promise)
      } else {
        guard let url = Self.fileURL(from: videoUri) else {
          promise.reject("INVALID_URI", "Cannot parse video URI: \(videoUri)")
          return
        }
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
        self.extractPCM(from: asset, promise: promise) { pcmData in
          self.writeWAV(pcmData: pcmData, promise: promise)
        }
      }
    }
  }

  // MARK: - URL helpers

  private static func fileURL(from uri: String) -> URL? {
    if uri.hasPrefix("file://") {
      return URL(string: uri)
    }
    return URL(fileURLWithPath: uri)
  }

  // MARK: - Photos library (ph:// / assets-library://)

  private func extractFromPhotosAsset(uri: String, promise: Promise) {
    // The full path after stripping the scheme IS the PHAsset localIdentifier
    // (e.g. ph://UUID/V0/L0/1 → "UUID/V0/L0/1"). Do not split on "/".
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
      self.extractPCM(from: avAsset, promise: promise) { pcmData in
        self.writeWAV(pcmData: pcmData, promise: promise)
      }
    }
  }

  // MARK: - Core extraction

  private func extractPCM(from asset: AVAsset, promise: Promise, completion: @escaping (Data) -> Void) {
    asset.loadValuesAsynchronously(forKeys: ["tracks"]) {
      var loadError: NSError?
      let status = asset.statusOfValue(forKey: "tracks", error: &loadError)

      guard status == .loaded else {
        promise.reject("LOAD_FAILED", "Failed to load asset tracks: \(loadError?.localizedDescription ?? "unknown")")
        return
      }

      guard let audioTrack = asset.tracks(withMediaType: .audio).first else {
        promise.reject("NO_AUDIO_TRACK", "Video has no audio track")
        return
      }

      let outputSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 44100.0,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
      ]

      do {
        let reader = try AVAssetReader(asset: asset)
        let trackOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
        reader.add(trackOutput)

        guard reader.startReading() else {
          promise.reject("READ_FAILED", "AVAssetReader cannot start: \(reader.error?.localizedDescription ?? "unknown")")
          return
        }

        var pcmData = Data()
        while reader.status == .reading {
          guard let sampleBuffer = trackOutput.copyNextSampleBuffer() else { break }
          if let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) {
            let length = CMBlockBufferGetDataLength(blockBuffer)
            var chunk = Data(count: length)
            chunk.withUnsafeMutableBytes { ptr in
              _ = CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: ptr.baseAddress!)
            }
            pcmData.append(chunk)
          }
        }

        guard reader.status == .completed else {
          promise.reject("READ_FAILED", "AVAssetReader status \(reader.status.rawValue): \(reader.error?.localizedDescription ?? "unknown")")
          return
        }

        completion(pcmData)
      } catch {
        promise.reject("READER_ERROR", error.localizedDescription)
      }
    }
  }

  // MARK: - WAV writer

  private func writeWAV(pcmData: Data, promise: Promise) {
    let sampleRate: UInt32 = 44100
    let numChannels: UInt16 = 1
    let bitsPerSample: UInt16 = 16
    let byteRate = sampleRate * UInt32(numChannels) * UInt32(bitsPerSample) / 8
    let blockAlign = numChannels * bitsPerSample / 8
    let dataSize = UInt32(pcmData.count)
    let chunkSize = dataSize + 36

    var header = Data()
    header.append(contentsOf: "RIFF".utf8)
    header.appendLE(chunkSize)
    header.append(contentsOf: "WAVE".utf8)
    header.append(contentsOf: "fmt ".utf8)
    header.appendLE(UInt32(16))
    header.appendLE(UInt16(1))
    header.appendLE(numChannels)
    header.appendLE(sampleRate)
    header.appendLE(byteRate)
    header.appendLE(blockAlign)
    header.appendLE(bitsPerSample)
    header.append(contentsOf: "data".utf8)
    header.appendLE(dataSize)

    let wavData = header + pcmData
    let outputURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString + ".wav")

    do {
      try wavData.write(to: outputURL)
      promise.resolve(outputURL.absoluteString)
    } catch {
      promise.reject("WRITE_FAILED", "Could not write WAV: \(error.localizedDescription)")
    }
  }
}

private extension Data {
  mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
    var v = value.littleEndian
    let ptr = UnsafeRawBufferPointer(start: &v, count: MemoryLayout<T>.size)
    self.append(contentsOf: ptr)
  }
}
