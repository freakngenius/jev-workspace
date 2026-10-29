// Jev Workspace for the Dock: a native window around the local web app.
//
// On launch it looks for a server on 127.0.0.1:3131 and uses it when one is up (`npm run dev`, say).
// Otherwise it runs desktop/serve.sh, which rebuilds when the code changed and starts the production
// server, and it stops that server again on quit. Build and install it with `npm run desktop`.
// `open -a "Jev Workspace" --args -open /runs/<id>/results` opens straight to a page.
// Its own events go to the unified log: /usr/bin/log show --last 10m --predicate 'subsystem == "local.jev-workspace"'

import Cocoa
import WebKit
import os

let logger = Logger(subsystem: "local.jev-workspace", category: "app")

let origin = URL(string: "http://127.0.0.1:3131/")!
let plane = NSColor(srgbRed: 0x0c / 255.0, green: 0x0c / 255.0, blue: 0x0b / 255.0, alpha: 1)

/// Written by desktop/build.sh: where the project lives, and a PATH that finds node.
struct Config: Decodable {
  let project: String
  let path: String
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
  private var window: NSWindow!
  private var web: WKWebView!
  private var server: Process?
  private var serverExited: DispatchSemaphore?
  private var log: FileHandle?
  private var waiting: Task<Void, Never>?
  private var quitting = false
  private var titleWatch: NSKeyValueObservation?
  private var downloads: [ObjectIdentifier: URL] = [:]
  private var sigterm: DispatchSourceSignal?
  /// `-open <path>` from the command line, for the first page load only: later loads (New Mission, Try again) go home.
  private var openOnce = UserDefaults.standard.string(forKey: "open")
  private let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Jev Workspace/server.log")

  private lazy var config: Config? = {
    guard let url = Bundle.main.url(forResource: "config", withExtension: "json"),
          let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(Config.self, from: data)
  }()

  func applicationDidFinishLaunching(_ notification: Notification) {
    // A plain `kill` should quit the same way the menu does, so the server it started stops too.
    // A no-op handler, not SIG_IGN: an ignored signal stays ignored in the server and its build, a handled one resets.
    signal(SIGTERM) { _ in }
    sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    sigterm?.setEventHandler { NSApp.terminate(nil) }
    sigterm?.resume()
    buildMenu()
    buildWindow()
    connect()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  // Synchronous on purpose: while a quit is pending AppKit runs a modal run loop, and queued async work never ran there.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let server, server.isRunning else { return .terminateNow }
    if runsInProgress() > 0 {
      let alert = NSAlert()
      alert.messageText = "A run is still going"
      alert.informativeText = "Quitting stops the server, so the run ends early. Its results so far are kept."
      alert.addButton(withTitle: "Quit Anyway")
      alert.addButton(withTitle: "Cancel")
      if alert.runModal() != .alertFirstButtonReturn { return .terminateCancel }
    }
    quitting = true
    logger.log("Quitting, so stopping the server")
    stop(server)
    return .terminateNow
  }

  // MARK: Server

  private func connect() {
    showStatus("Starting Jev Workspace…")
    Task {
      if await isUp() {
        logger.log("Using the server already on 127.0.0.1:3131")
        openApp()
      } else {
        logger.log("Starting the server")
        startServer()
      }
    }
  }

  private func isUp() async -> Bool {
    var request = URLRequest(url: origin.appendingPathComponent("api/status"))
    request.timeoutInterval = 2
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
    return (response as? HTTPURLResponse)?.statusCode == 200
  }

  /// Blocks for at most three seconds, only while quitting.
  private func runsInProgress() -> Int {
    final class Count: @unchecked Sendable { var value = 0 }
    let count = Count()
    let done = DispatchSemaphore(value: 0)
    var request = URLRequest(url: origin.appendingPathComponent("api/runs"))
    request.timeoutInterval = 2
    URLSession.shared.dataTask(with: request) { data, _, _ in
      if let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let runs = body["runs"] as? [[String: Any]] {
        count.value = runs.filter { $0["status"] as? String == "running" }.count
      }
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 3)
    return count.value
  }

  private func startServer() {
    guard let config else {
      return showError("This copy of the app has no settings. Run npm run desktop in the project folder to rebuild it.", tail: "")
    }
    let script = URL(fileURLWithPath: config.project).appendingPathComponent("desktop/serve.sh")
    guard FileManager.default.fileExists(atPath: script.path) else {
      return showError("The project isn't at \(config.project) any more. If you moved it, run npm run desktop from its new place.", tail: "")
    }
    // One launch per log file: the log shows this session only.
    try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    log = try? FileHandle(forWritingTo: logURL)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = [script.path]
    process.currentDirectoryURL = URL(fileURLWithPath: config.project)
    // Apps opened from the Dock get a bare PATH; the one saved at build time finds node and the claude CLI.
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = config.path
    process.environment = env
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    pipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      if data.isEmpty { handle.readabilityHandler = nil; return }
      Task { @MainActor in self.serverSaid(data) }
    }
    let exited = DispatchSemaphore(value: 0)
    process.terminationHandler = { finished in
      let code = finished.terminationStatus
      exited.signal()
      Task { @MainActor in self.serverStopped(code) }
    }
    do {
      try process.run()
    } catch {
      return showError("Couldn't start the server: \(error.localizedDescription)", tail: "")
    }
    server = process
    serverExited = exited
    waitForServer(until: Date().addingTimeInterval(600))
  }

  private func serverSaid(_ data: Data) {
    log?.write(data)
    let text = String(decoding: data, as: UTF8.self)
    if text.contains("jev: building") {
      showStatus("Building the latest version. After a code change this takes about a minute.")
    } else if text.contains("jev: starting") {
      showStatus("Starting the server…")
    }
  }

  private func serverStopped(_ code: Int32) {
    logger.log("Server stopped with exit code \(code)")
    server = nil
    try? log?.close()
    log = nil
    if quitting { return }
    let wasWaiting = waiting != nil
    waiting?.cancel()
    waiting = nil
    showError(wasWaiting ? "The server stopped before it was ready (exit code \(code))." : "The server stopped (exit code \(code)).", tail: tail())
  }

  private func waitForServer(until deadline: Date) {
    waiting?.cancel()
    waiting = Task {
      while !Task.isCancelled {
        if await isUp() {
          waiting = nil
          logger.log("Server is up")
          openApp()
          return
        }
        if Date() > deadline {
          waiting = nil
          showError("The server didn't answer within 10 minutes.", tail: tail())
          return
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
      }
    }
  }

  private func stop(_ process: Process) {
    // serve.sh turns SIGINT into a clean shutdown of the server, or of a build in progress.
    process.interrupt()
    if serverExited?.wait(timeout: .now() + 5) == .timedOut, process.isRunning {
      kill(process.processIdentifier, SIGKILL)
    }
  }

  private func tail() -> String {
    guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return "" }
    return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(30).joined(separator: "\n")
  }

  // MARK: Window

  private func buildWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Jev Workspace"
    window.titlebarAppearsTransparent = true
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = plane
    window.minSize = NSSize(width: 480, height: 520)
    window.isReleasedWhenClosed = false
    window.center()
    window.setFrameUsingName("JevWorkspaceMain")
    window.setFrameAutosaveName("JevWorkspaceMain")

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    web = WKWebView(frame: .zero, configuration: configuration)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsBackForwardNavigationGestures = true
    web.underPageBackgroundColor = plane
    web.setValue(false, forKey: "drawsBackground") // no white flash before the first paint
    web.isInspectable = true
    window.contentView = web
    titleWatch = web.observe(\.title, options: [.new]) { [weak self] view, _ in
      let title = view.title ?? ""
      Task { @MainActor in self?.window.title = title.isEmpty ? "Jev Workspace" : title }
    }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  private func openApp() {
    var target = origin
    // -open goes straight to a page of the workspace, never anywhere else.
    if let path = openOnce, let url = URL(string: path, relativeTo: origin)?.absoluteURL, isLocal(url) { target = url }
    openOnce = nil
    web.load(URLRequest(url: target))
  }

  private func isLocal(_ url: URL) -> Bool {
    (url.host == "127.0.0.1" || url.host == "localhost") && url.port == 3131
  }

  // MARK: Status pages

  private func showStatus(_ message: String) {
    web.loadHTMLString(page("""
      <div class="eyebrow">JEV / WORKSPACE</div>
      <div class="tiles"><i></i><i></i><i></i><i></i><i></i></div>
      <p>\(escape(message))</p>
      """), baseURL: nil)
  }

  private func showError(_ message: String, tail: String) {
    web.loadHTMLString(page("""
      <div class="eyebrow">JEV / WORKSPACE</div>
      <h1>Couldn't open the workspace</h1>
      <p>\(escape(message))</p>
      \(tail.isEmpty ? "" : "<pre>\(escape(tail))</pre>")
      <div class="row"><a href="jev:retry">Try again</a><a class="ghost" href="jev:log">Open the log</a></div>
      """), baseURL: nil)
  }

  private func page(_ body: String) -> String {
    """
    <!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0c0c0b;color:#f3efe6;font:15px/1.5 -apple-system,system-ui,sans-serif}
    main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;box-sizing:border-box;text-align:center}
    .eyebrow{font:11px/1 ui-monospace,Menlo,monospace;letter-spacing:.22em;color:#8b8983}
    h1{margin:0;font:italic 400 34px/1.15 ui-serif,Georgia,serif}
    p{margin:0;color:#c3c2b7;max-width:34rem}
    .tiles{display:flex;gap:6px}
    .tiles i{width:12px;height:12px;border-radius:3px;background:#2a2a27;animation:lit 1.5s infinite}
    .tiles i:nth-child(2){animation-delay:.15s}.tiles i:nth-child(3){animation-delay:.3s}
    .tiles i:nth-child(4){animation-delay:.45s}.tiles i:nth-child(5){animation-delay:.6s}
    @keyframes lit{0%,100%{background:#2a2a27}35%{background:#0ca30c}65%{background:#efe6d2}}
    pre{max-width:min(46rem,100%);max-height:40vh;overflow:auto;text-align:left;font:12px/1.5 ui-monospace,Menlo,monospace;color:#c3c2b7;background:#171716;border:1px solid #2a2a27;border-radius:10px;padding:12px;margin:0;white-space:pre-wrap}
    .row{display:flex;gap:10px}
    a{color:#0c0c0b;background:#efe6d2;text-decoration:none;border-radius:999px;padding:8px 16px;font-weight:600}
    a.ghost{background:none;color:#f3efe6;border:1px solid #3a3935}
    </style><main>\(body)</main>
    """
  }

  private func escape(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
  }

  // MARK: Navigation

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
    if url.scheme == "jev" {
      decisionHandler(.cancel)
      if url.absoluteString == "jev:retry" { connect() } else { showLog() }
      return
    }
    if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
    if isLocal(url) || ["about", "data", "blob"].contains(url.scheme ?? "") { return decisionHandler(.allow) }
    // Profile links and item pages open in the default browser, not inside the workspace.
    if navigationAction.targetFrame?.isMainFrame ?? true {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
    // Exports are served as attachments; WebKit would otherwise show a CSV or JSON as a page.
    let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    if disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType {
      return decisionHandler(.download)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
    let code = (error as NSError).code
    if code == NSURLErrorCancelled || code == 102 { return } // 102: a navigation turned into a download
    logger.error("Page failed to load: \(error.localizedDescription, privacy: .public)")
    showError("The workspace didn't load: \(error.localizedDescription)", tail: server == nil ? "" : tail())
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if let url = webView.url, isLocal(url) { logger.log("Showing \(url.absoluteString, privacy: .public)") }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url {
      if isLocal(url) { webView.load(navigationAction.request) } else { NSWorkspace.shared.open(url) }
    }
    return nil
  }

  // MARK: Panels

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = !parameters.allowsDirectories
    panel.beginSheetModal(for: window) { response in
      completionHandler(response == .OK ? panel.urls : nil)
    }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
  }

  // MARK: Downloads

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
    let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    let name = suggestedFilename as NSString
    var target = folder.appendingPathComponent(suggestedFilename)
    var n = 1
    while FileManager.default.fileExists(atPath: target.path) {
      let numbered = name.pathExtension.isEmpty ? "\(name) (\(n))" : "\(name.deletingPathExtension) (\(n)).\(name.pathExtension)"
      target = folder.appendingPathComponent(numbered)
      n += 1
    }
    downloads[ObjectIdentifier(download)] = target
    completionHandler(target)
  }

  func downloadDidFinish(_ download: WKDownload) {
    if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) {
      logger.log("Saved \(file.lastPathComponent, privacy: .public) to Downloads")
      // The same nudge Safari gives: the Downloads stack in the Dock bounces.
      DistributedNotificationCenter.default().post(name: Notification.Name("com.apple.DownloadFileFinished"), object: file.path)
    }
    showWorkspaceBehindDownload()
  }

  func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
    downloads.removeValue(forKey: ObjectIdentifier(download))
    logger.error("Download failed: \(error.localizedDescription, privacy: .public)")
    showWorkspaceBehindDownload()
    let alert = NSAlert()
    alert.messageText = "The download failed"
    alert.informativeText = error.localizedDescription
    alert.beginSheetModal(for: window)
  }

  /// A download opened with -open leaves the start page showing. Loading anything while WebKit is still
  /// turning the response into a download cancels both, so this waits until the download is over.
  private func showWorkspaceBehindDownload() {
    if !(web.backForwardList.currentItem.map { isLocal($0.url) } ?? false) { web.load(URLRequest(url: origin)) }
  }

  // MARK: Menu

  @objc private func newMission() { openApp() }
  @objc private func reload() {
    if web.url?.scheme == "about" { connect() } else { web.reload() }
  }
  @objc private func goBack() { web.goBack() }
  @objc private func goForward() { web.goForward() }
  @objc private func zoomIn() { web.pageZoom = min(web.pageZoom + 0.1, 2.5) }
  @objc private func zoomOut() { web.pageZoom = max(web.pageZoom - 0.1, 0.5) }
  @objc private func zoomReset() { web.pageZoom = 1 }
  @objc private func openInBrowser() { NSWorkspace.shared.open(web.url.flatMap { isLocal($0) ? $0 : nil } ?? origin) }
  @objc private func showLog() {
    if FileManager.default.fileExists(atPath: logURL.path) { NSWorkspace.shared.open(logURL) } else { NSSound.beep() }
  }

  private func buildMenu() {
    let bar = NSMenu()
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command, mine: Bool = false) -> NSMenuItem {
      let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
      entry.keyEquivalentModifierMask = modifiers
      if mine { entry.target = self }
      return entry
    }
    @discardableResult func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let submenu = NSMenu(title: title)
      items.forEach(submenu.addItem)
      let host = NSMenuItem()
      host.submenu = submenu
      bar.addItem(host)
      return submenu
    }
    menu("Jev Workspace", [
      item("About Jev Workspace", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Hide Jev Workspace", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Quit Jev Workspace", #selector(NSApplication.terminate(_:)), "q"),
    ])
    menu("File", [
      item("New Mission", #selector(newMission), "n", mine: true),
      item("Open in Browser", #selector(openInBrowser), "o", [.command, .shift], mine: true),
      .separator(),
      item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
    ])
    menu("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    menu("View", [
      item("Reload", #selector(reload), "r", mine: true),
      item("Back", #selector(goBack), "[", mine: true),
      item("Forward", #selector(goForward), "]", mine: true),
      .separator(),
      item("Actual Size", #selector(zoomReset), "0", mine: true),
      item("Zoom In", #selector(zoomIn), "=", mine: true),
      item("Zoom Out", #selector(zoomOut), "-", mine: true),
    ])
    NSApp.windowsMenu = menu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
    ])
    menu("Help", [item("Show Server Log", #selector(showLog), mine: true)])
    NSApp.mainMenu = bar
  }
}

// Top-level code runs on the main thread; this says so to the compiler.
MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(.regular)
  app.run()
}
