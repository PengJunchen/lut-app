import Foundation
import Metal
import Darwin

// Only LUT interpolation runs on Metal. FFmpeg retains responsibility for
// range, matrix, chroma resampling, timing, audio and container metadata.
enum Failure: Error { case invalid(String) }
func check(_ condition: Bool, _ message: String) throws {
    if !condition { throw Failure.invalid(message) }
}

let shader = """
#include <metal_stdlib>
using namespace metal;
struct Params { uint count; uint grid; };
float3 atLUT(device const float4 *t, uint3 p, uint n) {
    return t[p.x + n * (p.y + n * p.z)].xyz;
}
float3 tetra(float3 rgb, device const float4 *t, uint n) {
    float3 p = clamp(rgb, 0.0f, 1.0f) * float(n - 1);
    uint3 lo = uint3(floor(p)), hi = min(lo + 1, uint3(n - 1));
    float3 f = p - float3(lo), s;
    uint3 a = lo, b = hi;
    if (f.x >= f.y) {
        if (f.y >= f.z) { a.x = hi.x; b.z = lo.z; s = f.xyz; }
        else if (f.x >= f.z) { a.x = hi.x; b.y = lo.y; s = f.xzy; }
        else { a.z = hi.z; b.y = lo.y; s = f.zxy; }
    } else {
        if (f.x >= f.z) { a.y = hi.y; b.z = lo.z; s = f.yxz; }
        else if (f.y >= f.z) { a.y = hi.y; b.x = lo.x; s = f.yzx; }
        else { a.z = hi.z; b.x = lo.x; s = f.zyx; }
    }
    return (1-s.x)*atLUT(t,lo,n) + (s.x-s.y)*atLUT(t,a,n)
         + (s.y-s.z)*atLUT(t,b,n) + s.z*atLUT(t,hi,n);
}
kernel void apply(device const ushort *src [[buffer(0)]],
                    device ushort *dst [[buffer(1)]],
                    device const float4 *lut [[buffer(2)]],
                    constant Params &p [[buffer(3)]],
                    uint i [[thread_position_in_grid]]) {
    if (i >= p.count) return;
    float3 rgb = float3(src[2*p.count+i],src[i],src[p.count+i]) / 65535.0f;
    float3 v = rint(clamp(tetra(rgb,lut,p.grid),0.0f,1.0f)*65535.0f);
    dst[2*p.count+i]=ushort(v.r); dst[i]=ushort(v.g); dst[p.count+i]=ushort(v.b);
}
"""

final class LUT {
    let queue: MTLCommandQueue
    let pipeline: MTLComputePipelineState
    let table: MTLBuffer
    let source: MTLBuffer
    let destination: MTLBuffer
    let count: Int
    let bytes: Int
    let grid: Int

    init(path: String, width: Int, height: Int) throws {
        guard let device = MTLCreateSystemDefaultDevice(), device.hasUnifiedMemory,
              let queue = device.makeCommandQueue() else {
            throw Failure.invalid("Metal requires an Apple Silicon GPU")
        }
        self.queue = queue
        try check(width > 0 && height > 0 && width <= 8192 && height <= 8192,
                  "Unsupported frame dimensions")
        count = width * height
        bytes = count * 6
        let options = MTLCompileOptions()
        options.fastMathEnabled = false
        let library = try device.makeLibrary(source: shader, options: options)
        guard let function = library.makeFunction(name: "apply") else {
            throw Failure.invalid("Missing Metal function")
        }
        pipeline = try device.makeComputePipelineState(function: function)
        var grid = 0, rows = [SIMD4<Float>]()
        for raw in try String(contentsOfFile: path, encoding: .utf8).split(whereSeparator: { $0.isNewline }) {
            let line = raw.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
            let fields = line.split(whereSeparator: { $0.isWhitespace })
            if fields.isEmpty { continue }
            if fields[0] == "LUT_3D_SIZE" {
                try check(fields.count == 2 && grid == 0, "Invalid LUT grid")
                grid = Int(fields[1]) ?? 0
                try check(grid >= 2 && grid <= 65, "Unsupported LUT grid")
            } else if fields[0] == "DOMAIN_MIN" || fields[0] == "DOMAIN_MAX" || fields[0] == "LUT_3D_INPUT_RANGE" {
                throw Failure.invalid("Non-default LUT domain is unsupported")
            } else if fields.count == 3, let r = Float(fields[0]),
                      let g = Float(fields[1]), let b = Float(fields[2]) {
                try check(r.isFinite && g.isFinite && b.isFinite && rows.count < 65*65*65,
                          "Invalid LUT values")
                try check(r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1,
                          "LUT output range requires the CPU pipeline")
                rows.append(SIMD4(r, g, b, 1))
            } else if fields[0] != "TITLE" {
                throw Failure.invalid("Unsupported LUT directive")
            }
        }
        try check(grid > 1 && rows.count == grid*grid*grid, "Incomplete LUT")
        self.grid = grid
        guard let table = rows.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
              let source = device.makeBuffer(length: bytes, options: .storageModeShared),
              let destination = device.makeBuffer(length: bytes, options: .storageModeShared) else {
            throw Failure.invalid("Metal buffer allocation failed")
        }
        self.table = table; self.source = source; self.destination = destination
    }

    func apply() throws {
        guard let command = queue.makeCommandBuffer(), let encoder = command.makeComputeCommandEncoder() else {
            throw Failure.invalid("Metal command allocation failed")
        }
        var params = SIMD2<UInt32>(UInt32(count), UInt32(grid))
        encoder.setComputePipelineState(pipeline)
        encoder.setBuffer(source, offset: 0, index: 0)
        encoder.setBuffer(destination, offset: 0, index: 1)
        encoder.setBuffer(table, offset: 0, index: 2)
        encoder.setBytes(&params, length: MemoryLayout.size(ofValue: params), index: 3)
        encoder.dispatchThreads(MTLSize(width: count, height: 1, depth: 1),
                                threadsPerThreadgroup: MTLSize(width: min(256, pipeline.maxTotalThreadsPerThreadgroup), height: 1, depth: 1))
        encoder.endEncoding()
        command.commit()
        command.waitUntilCompleted()
        if let error = command.error { throw error }
        try check(command.status == .completed, "Metal command did not complete")
    }
}

func readInto(_ pointer: UnsafeMutableRawPointer, _ count: Int) throws {
    var offset = 0
    while offset < count {
        let n = fread(pointer.advanced(by: offset), 1, count-offset, stdin)
        try check(n > 0, "Truncated input stream")
        offset += n
    }
}
func writeFrom(_ pointer: UnsafeRawPointer, _ count: Int) throws {
    var offset = 0
    while offset < count {
        let n = fwrite(pointer.advanced(by: offset), 1, count-offset, stdout)
        try check(n > 0, "Output stream closed")
        offset += n
    }
}
func writeData(_ data: Data) throws {
    try data.withUnsafeBytes { if let p = $0.baseAddress { try writeFrom(p, $0.count) } }
}
func readData(_ count: Int) throws -> Data {
    try check(count >= 0 && count <= 1<<20, "Oversized container header")
    var data = Data(count: count)
    try data.withUnsafeMutableBytes { if let p = $0.baseAddress { try readInto(p, $0.count) } }
    return data
}

// A bounded NUT v3 packet bridge, for our own FFmpeg pipe only. Headers,
// timestamps and non-video payloads pass through byte for byte. Frame CRCs
// cover the unchanged frame header, not the pixel payload. No demux/remux,
// frame-rate reconstruction or temporary uncompressed video is required.
// Format reference: https://ffmpeg.org/nut.html
struct Cursor {
    let data: Data
    var offset = 0
    mutating func byte() throws -> UInt8 {
        try check(offset < data.count, "Truncated container header")
        defer { offset += 1 }
        return data[offset]
    }
    mutating func uint() throws -> Int {
        var result = 0
        for _ in 0..<9 {
            let b = try byte()
            try check(result <= (Int.max >> 7), "Container integer overflow")
            result = (result << 7) | Int(b & 127)
            if b & 128 == 0 { return result }
        }
        throw Failure.invalid("Invalid container integer")
    }
    mutating func skip(_ count: Int) throws {
        try check(count >= 0 && count <= data.count-offset, "Truncated container field")
        offset += count
    }
}
struct FrameCode {
    var flags = 8192, multiplier = 1, size = 0, stream = 0, reserved = 0, header = 0
}
final class Bridge {
    let lut: LUT
    let width: Int, height: Int
    var codes = [FrameCode](repeating: FrameCode(), count: 256)
    var videoID: Int?
    var streams = 0
    var frames = 0
    var header = Data()

    init(_ lut: LUT, _ width: Int, _ height: Int) { self.lut = lut; self.width = width; self.height = height }
    func uint() throws -> Int {
        var result = 0
        for _ in 0..<9 {
            let c = fgetc(stdin)
            try check(c != EOF && header.count < 65536 && result <= Int.max >> 7, "Invalid frame header")
            header.append(UInt8(c))
            result = (result << 7) | Int(c & 127)
            if c & 128 == 0 { return result }
        }
        throw Failure.invalid("Invalid frame integer")
    }
    func mainHeader(_ data: Data) throws {
        var c = Cursor(data: data)
        try check(try c.uint() == 3, "Unsupported NUT version")
        streams = try c.uint()
        try check(streams >= 1 && streams <= 64, "Invalid stream count")
        _ = try c.uint()
        let bases = try c.uint()
        try check(bases > 0 && bases <= 128, "Invalid time bases")
        for _ in 0..<bases { _ = try c.uint(); _ = try c.uint() }
        var multiplier = 1, stream = 0, index = 0, headerIndex = 0
        while index < 256 {
            let flags = try c.uint(), fields = try c.uint()
            try check(fields <= 32, "Invalid frame-code fields")
            if fields > 0 { _ = try c.uint() }
            if fields > 1 { multiplier = try c.uint() }
            if fields > 2 { stream = try c.uint() }
            let size = fields > 3 ? try c.uint() : 0
            let reserved = fields > 4 ? try c.uint() : 0
            let count = fields > 5 ? try c.uint() : multiplier-size
            if fields > 6 { _ = try c.uint() }
            if fields > 7 { headerIndex = try c.uint() }
            if fields > 8 { for _ in 8..<fields { _ = try c.uint() } }
            try check(count > 0 && count <= 256-index && multiplier <= 65535 && stream < streams && reserved <= 255,
                      "Invalid frame-code table")
            for j in 0..<count {
                if index == 78 { index += 1 }
                try check(index < 256, "Invalid frame-code count")
                codes[index] = FrameCode(flags: flags, multiplier: multiplier, size: size+j, stream: stream, reserved: reserved, header: headerIndex)
                index += 1
            }
        }
    }
    func streamHeader(_ data: Data) throws {
        var c = Cursor(data: data)
        let id = try c.uint(), type = try c.uint(), tagSize = try c.uint()
        try check(id < streams && tagSize <= 8, "Invalid stream header")
        let start = c.offset
        try c.skip(tagSize)
        if type != 0 { return }
        try check((videoID == nil || videoID == id) && Array(data[start..<c.offset]) == [71, 51, 0, 16], "Expected one 16-bit GBR video stream")
        videoID = id
        for _ in 0..<5 { _ = try c.uint() }
        let extra = try c.uint()
        try c.skip(extra)
        try check(try c.uint() == width && c.uint() == height, "Video dimensions changed")
    }
    func run() throws {
        let id = try readData(25)
        try check(id == Data("nut/multimedia container\0".utf8), "Expected NUT pipe")
        try writeData(id)
        let scratch = UnsafeMutableRawPointer.allocate(byteCount: 1<<20, alignment: 16)
        defer { scratch.deallocate() }
        while true {
            let byte = fgetc(stdin)
            if byte == EOF {
                try check(feof(stdin) != 0 && frames > 0, "No complete video frames")
                break
            }
            header = Data([UInt8(byte)])
            if byte == 78 {
                header.append(try readData(7))
                let code = Array(header)
                let length = try uint()
                try check(length >= 4 && length <= 1<<20, "Invalid container packet length")
                if length > 4096 { header.append(try readData(4)) }
                let data = try readData(length)
                switch code {
                case [78,77,122,86,31,95,4,173]: try mainHeader(data)
                case [78,83,17,64,91,242,249,219]: try streamHeader(data)
                case [78,75,228,173,238,202,69,105], [78,73,171,104,181,150,186,120], [78,88,221,103,47,35,230,78]: break
                default: throw Failure.invalid("Unknown container packet")
                }
                try writeData(header); try writeData(data)
                continue
            }
            let code = codes[Int(byte)]
            var flags = code.flags, stream = code.stream, size = code.size, headerIndex = code.header, reserved = code.reserved
            try check(flags & 8192 == 0, "Invalid frame code")
            if flags & 4096 != 0 { flags ^= try uint() }
            if flags & 16 != 0 { stream = try uint() }
            if flags & 8 != 0 { _ = try uint() }
            if flags & 32 != 0 {
                let high = try uint()
                try check(code.multiplier > 0 && high <= (1<<30)/code.multiplier, "Oversized frame")
                size += high * code.multiplier
            }
            if flags & 2048 != 0 { _ = try uint() }
            if flags & 1024 != 0 { headerIndex = try uint() }
            if flags & 128 != 0 { reserved = try uint() }
            try check(reserved <= 255 && stream < streams && size >= 0 && size <= 1<<30,
                      "Invalid frame payload")
            for _ in 0..<reserved { _ = try uint() }
            try check(size > 4096 || headerIndex == 0, "Elided packet headers unsupported")
            if flags & 64 != 0 { header.append(try readData(4)) }
            try writeData(header)
            if stream == videoID {
                try check(flags & 256 == 0 && size == lut.bytes, "Unexpected video frame layout")
                try readInto(lut.source.contents(), size)
                try autoreleasepool { try lut.apply() }
                try writeFrom(lut.destination.contents(), size)
                frames += 1
            } else {
                var remaining = size
                while remaining > 0 {
                    let n = min(remaining, 1<<20)
                    try readInto(scratch, n); try writeFrom(scratch, n)
                    remaining -= n
                }
            }
        }
        try check(fflush(stdout) == 0, "Cannot flush output stream")
        fputs("Metal LUT completed: \(frames) frames\n", stderr)
    }
}

do {
    signal(SIGPIPE, SIG_IGN)
    let args = CommandLine.arguments
    try check(args.count == 4, "Usage: metal-lut <cube> <width> <height>")
    guard let width = Int(args[2]), let height = Int(args[3]) else { throw Failure.invalid("Invalid dimensions") }
    let lut = try LUT(path: args[1], width: width, height: height)
    try Bridge(lut, width, height).run()
} catch {
    fputs("Metal LUT: \(error)\n", stderr)
    exit(1)
}
