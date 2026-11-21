import Foundation
import Vision
import ImageIO
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]
try VNImageRequestHandler(url: url).perform([request])
let rows = (request.results ?? []).compactMap { observation -> [String: Any]? in
    guard let text = observation.topCandidates(1).first else { return nil }
    let b = observation.boundingBox
    return ["text": text.string, "confidence": text.confidence, "bbox": [Double(b.minX),Double(b.minY),Double(b.width),Double(b.height)]]
}.sorted { (($0["bbox"] as! [Double])[1]) > (($1["bbox"] as! [Double])[1]) }
let data = try JSONSerialization.data(withJSONObject: rows)
FileHandle.standardOutput.write(data)
