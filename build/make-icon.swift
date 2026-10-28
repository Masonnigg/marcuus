import AppKit
// usage: swift make-icon.swift <source image> <out.png>
let args = CommandLine.arguments
guard let src = NSImage(contentsOfFile: args[1]) else { fatalError("cannot read image") }
let S = 1024.0, inset = 100.0, side = S - 2 * inset, radius = 185.0
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(S), pixelsHigh: Int(S), bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current!.imageInterpolation = .high
let box = NSRect(x: inset, y: inset, width: side, height: side)
let path = NSBezierPath(roundedRect: box, xRadius: radius, yRadius: radius)
// soft drop shadow like native icons
let shadow = NSShadow(); shadow.shadowBlurRadius = 24; shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.shadowColor = NSColor.black.withAlphaComponent(0.35); shadow.set()
NSColor(calibratedRed: 0.04, green: 0.04, blue: 0.05, alpha: 1).setFill(); path.fill()
NSShadow().set()
path.addClip()
// aspect-fill crop, centered
let sz = src.size, scale = max(side / sz.width, side / sz.height)
let w = sz.width * scale, h = sz.height * scale
src.draw(in: NSRect(x: inset + (side - w) / 2, y: inset + (side - h) / 2, width: w, height: h))
NSColor.white.withAlphaComponent(0.1).setStroke(); path.lineWidth = 3; path.stroke()
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
