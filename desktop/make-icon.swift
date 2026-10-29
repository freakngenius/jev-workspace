// Draws the app icon: a tile field caught mid-run. Judged tiles carry their band colors, the
// diagonal being judged glows cream, and the rest wait. Usage: make-icon <out.png>
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let size = 1024
guard let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else { fatalError("Could not make a bitmap.") }
rep.size = NSSize(width: size, height: size)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
  NSColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

// The body sits on Apple's icon grid: 824 square, 100 in from each edge, with a soft shadow below.
let body = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: body, xRadius: 186, yRadius: 186)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = color(0x000000, 0.5)
shadow.shadowBlurRadius = 24
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.set()
color(0x0c0c0b).setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()
NSGradient(starting: color(0x201f1d), ending: color(0x0c0c0b))!.draw(in: shape, angle: -90)
let rim = NSBezierPath(roundedRect: body.insetBy(dx: 2, dy: 2), xRadius: 184, yRadius: 184)
rim.lineWidth = 4
color(0x3a3935, 0.7).setStroke()
rim.stroke()

// Five by five tiles, top row first. M match, U uncertain, R reject, * being judged, . queued.
let rows = ["MRMU*", "RMU*.", "MM*..", "U*...", "*...."]
let field: CGFloat = 584, gap: CGFloat = 26
let tile = (field - gap * 4) / 5
let left = 512 - field / 2, top = 512 + field / 2
for (r, row) in rows.enumerated() {
  for (c, kind) in row.enumerated() {
    let rect = NSRect(x: left + CGFloat(c) * (tile + gap), y: top - CGFloat(r + 1) * tile - CGFloat(r) * gap, width: tile, height: tile)
    let path = NSBezierPath(roundedRect: rect, xRadius: tile * 0.2, yRadius: tile * 0.2)
    NSGraphicsContext.saveGraphicsState()
    switch kind {
    case "M": color(0x0ca30c).setFill()
    case "U": color(0xfab219).setFill()
    case "R": color(0x686761).setFill()
    case "*":
      let glow = NSShadow()
      glow.shadowColor = color(0xefe6d2, 0.75)
      glow.shadowBlurRadius = 34
      glow.set()
      color(0xefe6d2).setFill()
    default: color(0x232321).setFill()
    }
    path.fill()
    NSGraphicsContext.restoreGraphicsState()
    if kind == "." {
      path.lineWidth = 3
      color(0x34332f).setStroke()
      path.stroke()
    }
  }
}

NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("Could not encode the PNG.") }
try png.write(to: URL(fileURLWithPath: out))
