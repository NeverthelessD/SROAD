// SROAD — Dock 에 보이는 맥 앱 껍데기
// made by. Nevertheless_D
//
// 왜 이 껍데기가 있나요?
//   macOS 27 의 '백그라운드 앱 활동' 규칙: 앱을 종료한 뒤에도 창·메뉴 막대·Dock 없이 남아 도는 프로그램은
//   사용자에게 보여 주고, 허용되지 않으면 시스템이 끕니다. 예외는 '그 프로그램을 켠 앱이 Dock 에 있을 때'예요.
//   그래서 SROAD 는 이제 Dock 에 보이는 정식 앱이고, 엔진은 이 앱의 자식으로 '앱이 켜져 있는 동안만' 돌아요.
//   규칙을 피해 가는 장치(종료 신호 무시, 몰래 도는 도우미 앱)는 쓰지 않아요.
//
// 하는 일
//   1) 앱 안의 엔진을 ~/Library/Application Support/SROAD/bin 으로 복사 (업데이트로 앱 묶음이 바뀌어도 안전하게)
//   2) 엔진(지킴이 모드)을 자식으로 켜고, 127.0.0.1 + 토큰 주소를 앱 창(WKWebView)에 띄움
//   3) Dock 아이콘을 누르면 창을 다시 보여 주고, 앱을 종료하면 엔진도 깔끔하게 끔
//   4) 엔진이 끝나면 앱도 끝남 (화면의 '종료' 버튼) · 업데이트 후에는 새 버전을 다시 엶
//   5) 모든 단계를 launcher.log 에 기록

import AppKit
import Darwin
import WebKit

// MARK: - 경로 · 기록

enum Paths {
    static let support: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("SROAD", isDirectory: true)
    }()
    static let bin = support.appendingPathComponent("bin", isDirectory: true)
    static let engine = bin.appendingPathComponent("sroad-engine")
    static func file(_ name: String) -> URL { support.appendingPathComponent(name) }
}

enum Log {
    static func write(_ message: String) {
        let fm = FileManager.default
        try? fm.createDirectory(at: Paths.support, withIntermediateDirectories: true)
        let url = Paths.file("launcher.log")
        if let attrs = try? fm.attributesOfItem(atPath: url.path), let size = attrs[.size] as? NSNumber, size.intValue > 262_144 {
            let prev = Paths.file("launcher.prev.log")
            try? fm.removeItem(at: prev)
            try? fm.moveItem(at: url, to: prev)
        }
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = "MM-dd HH:mm:ss"
        let line = "\(df.string(from: Date())) [앱 \(getpid())] \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(data)
            h.closeFile()
        } else {
            try? data.write(to: url)
        }
    }
}

// MARK: - 엔진

final class Engine {
    var process: Process?
    var port: Int = 0
    var token: String = ""
    let build: String
    var onExit: ((Int32, Bool) -> Void)?

    init() {
        let v = Bundle.main.url(forResource: "version", withExtension: "txt")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "0.0.0"
        build = v.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func readText(_ name: String) -> String? {
        guard let s = try? String(contentsOf: Paths.file(name), encoding: .utf8) else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// 앱 안의 엔진을 앱 전용 폴더로 복사해요 (버전이 바뀌었을 때만)
    func prepare() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: Paths.bin, withIntermediateDirectories: true)
        let buildFile = Paths.bin.appendingPathComponent("build")
        let installed = (try? String(contentsOf: buildFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let want = build + "-native"
        if installed != want || !fm.isExecutableFile(atPath: Paths.engine.path) {
            guard let src = Bundle.main.url(forResource: "sroad-engine", withExtension: nil) else {
                throw NSError(domain: "SROAD", code: 1, userInfo: [NSLocalizedDescriptionKey: "앱 안에서 엔진을 찾지 못했어요"])
            }
            let tmp = Paths.bin.appendingPathComponent("sroad-engine.new")
            try? fm.removeItem(at: tmp)
            try fm.copyItem(at: src, to: tmp)
            chmod(tmp.path, 0o755)
            removexattr(tmp.path, "com.apple.quarantine", 0)
            if rename(tmp.path, Paths.engine.path) != 0 {
                throw NSError(domain: "SROAD", code: 2, userInfo: [NSLocalizedDescriptionKey: "엔진을 준비하지 못했어요"])
            }
            try want.write(to: buildFile, atomically: true, encoding: .utf8)
            Log.write("엔진 준비 (v\(build))")
        }
        removexattr(Paths.engine.path, "com.apple.quarantine", 0)
        // 1.0.1 의 '백그라운드 도우미 앱'은 이제 쓰지 않아요
        let oldHelper = Paths.bin.appendingPathComponent("SROAD Engine.app")
        if fm.fileExists(atPath: oldHelper.path) {
            try? fm.removeItem(at: oldHelper)
            Log.write("예전 도우미 앱을 지웠어요")
        }
    }

    /// 127.0.0.1 엔진에 짧게 요청해요 (응답이 200 이면 내용을 돌려줘요)
    func request(_ method: String, port: Int, path: String, token: String, timeout: TimeInterval) -> Data? {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue(token, forHTTPHeaderField: "x-token")
        if method == "POST" {
            req.httpBody = "{}".data(using: .utf8)
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let sem = DispatchSemaphore(value: 0)
        var out: Data?
        let task = URLSession.shared.dataTask(with: req) { data, resp, _ in
            if let h = resp as? HTTPURLResponse, h.statusCode == 200 { out = data ?? Data() }
            sem.signal()
        }
        task.resume()
        if sem.wait(timeout: .now() + timeout + 0.5) == .timedOut { task.cancel() }
        return out
    }

    /// 업데이트 뒤 다시 열린 앱인지 (그러면 작업 목록을 이어서 불러와요)
    var relaunched = false

    /// 이미 켜져 있는 엔진(예전 버전 · 도우미 앱 포함)이 있으면 끄고 새로 켜요
    func stopExisting() {
        guard let p = readText("port").flatMap({ Int($0) }), let t = readText("token") else { return }
        guard request("GET", port: p, path: "/api/ping", token: t, timeout: 1) != nil else { return }
        Log.write("이미 켜져 있던 엔진(포트 \(p))을 끄고 새로 켜요")
        _ = request("POST", port: p, path: "/api/quit", token: t, timeout: 2)
        for _ in 0..<40 {
            if request("GET", port: p, path: "/api/ping", token: t, timeout: 0.5) == nil { break }
            usleep(150_000)
        }
    }

    func start() throws {
        let fm = FileManager.default
        token = readText("token") ?? Engine.randomToken()
        try? fm.removeItem(at: Paths.file("port"))
        try? fm.removeItem(at: Paths.file("restart-requested"))

        let p = Process()
        p.executableURL = Paths.engine
        var env = ProcessInfo.processInfo.environment
        for k in ["SROAD_RESTART", "SROAD_PORT", "SROAD_CHILD", "SROAD_GRACE_SEC", "SROAD_RELAUNCHED"] { env.removeValue(forKey: k) }
        // 지난번과 같은 주소로 켜요 (예전 버전의 창이 열려 있으면 그 창이 새 모습 안내를 보여 줄 수 있게)
        if let last = readText("lastport") { env["SROAD_PORT"] = last }
        if relaunched { env["SROAD_RESTART"] = "1" }
        env["SROAD_SUPERVISOR"] = "1"
        env["SROAD_SHELL"] = "native"
        env["SROAD_VIA"] = "native"
        env["SROAD_TOKEN"] = token
        env["SROAD_SUPPORT"] = Paths.support.path
        env["SROAD_APP"] = Bundle.main.bundlePath
        env["SROAD_PARENT_PID"] = String(getpid())
        env["SROAD_PORT_WAIT"] = "1"
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            DispatchQueue.main.async { self?.exited(code) }
        }
        try p.run()
        process = p
        Log.write("엔진 켬 (지킴이 pid \(p.processIdentifier))")
    }

    func waitForPort() -> Int? {
        for _ in 0..<100 {
            if let v = readText("port").flatMap({ Int($0) }) {
                port = v
                return v
            }
            usleep(150_000)
        }
        return nil
    }

    private func exited(_ code: Int32) {
        let restart = FileManager.default.fileExists(atPath: Paths.file("restart-requested").path)
        process = nil
        onExit?(code, restart)
    }

    /// 앱을 종료할 때: 엔진에게 정중히 끄라고 하고, 안 꺼지면 종료 신호를 보내요
    func stop(completion: @escaping () -> Void) {
        guard let p = process, p.isRunning else { completion(); return }
        let port = self.port, token = self.token
        DispatchQueue.global(qos: .userInitiated).async {
            _ = self.request("POST", port: port, path: "/api/quit", token: token, timeout: 2)
            for _ in 0..<30 where p.isRunning { usleep(100_000) }
            if p.isRunning {
                p.terminate()
                for _ in 0..<20 where p.isRunning { usleep(100_000) }
            }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            DispatchQueue.main.async { completion() }
        }
    }

    static func randomToken() -> String {
        let chars = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<32).map { _ in chars[Int(arc4random_uniform(UInt32(chars.count)))] })
    }
}

// MARK: - 앱

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let engine = Engine()
    var quitting = false
    var pageURL: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        // 1.0.1 이하의 업데이트 기능이 이 앱을 직접 실행한 경우: macOS 정식 방법으로 다시 열고 이 실행은 끝내요
        if env["SROAD_RESTART"] == "1" && env["SROAD_RELAUNCHED"] != "1" {
            Log.write("예전 버전에서 업데이트됨 → 정식 방법으로 다시 열어요")
            relaunch()
            return
        }
        engine.relaunched = env["SROAD_RELAUNCHED"] == "1"
        Log.write("시작 v\(engine.build) · macOS \(ProcessInfo.processInfo.operatingSystemVersionString) · \(Bundle.main.bundlePath)")
        buildMenu()
        makeWindow()
        showLoading()
        engine.onExit = { [weak self] code, restart in self?.engineExited(code: code, restart: restart) }
        boot()
    }

    func boot() {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try self.engine.prepare()
                self.engine.stopExisting()
                try self.engine.start()
                guard let port = self.engine.waitForPort() else {
                    throw NSError(domain: "SROAD", code: 3, userInfo: [NSLocalizedDescriptionKey: "엔진이 준비되지 않았어요"])
                }
                Log.write("엔진 준비됨 (포트 \(port))")
                DispatchQueue.main.async { self.loadApp(port: port) }
            } catch {
                Log.write("⚠️ 시작 실패: \(error.localizedDescription)")
                DispatchQueue.main.async { self.startFailed(error) }
            }
        }
    }

    func loadApp(port: Int) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/?t=\(engine.token)") else { return }
        pageURL = url
        web.load(URLRequest(url: url))
    }

    func startFailed(_ error: Error) {
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "SROAD를 시작하지 못했어요"
        a.informativeText = "\(error.localizedDescription)\n앱을 다시 실행해 보세요. 계속 안 되면 맥을 재시동한 뒤 시도해 주세요."
        a.addButton(withTitle: "다시 시도")
        a.addButton(withTitle: "종료")
        if a.runModal() == .alertFirstButtonReturn {
            boot()
        } else {
            quitting = true
            NSApp.terminate(nil)
        }
    }

    func engineExited(code: Int32, restart: Bool) {
        if quitting { return }
        if restart {
            relaunch()
            return
        }
        Log.write("엔진이 끝나서 앱도 닫아요 (코드 \(code))")
        quitting = true
        NSApp.terminate(nil)
    }

    /// 업데이트된 새 버전을 macOS 정식 방법(LaunchServices)으로 다시 열고, 지금 앱은 끝내요
    func relaunch() {
        Log.write("새 버전으로 다시 열어요")
        quitting = true
        let appURL = URL(fileURLWithPath: Bundle.main.bundlePath)
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.createsNewApplicationInstance = true
        cfg.activates = true
        // 새로 여는 앱은 지금 앱의 환경 변수를 물려받아요. '다시 열어 줘' 표시(SROAD_RESTART)를 빼고,
        // 다시 연 앱이라는 표시를 붙여서 끝없이 다시 열리는 일이 없게 해요.
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "SROAD_RESTART")
        env["SROAD_RELAUNCHED"] = "1"
        cfg.environment = env
        unsetenv("SROAD_RESTART")
        NSWorkspace.shared.openApplication(at: appURL, configuration: cfg) { _, error in
            if let error = error { Log.write("⚠️ 다시 열지 못했어요: \(error.localizedDescription)") }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    // Dock 아이콘을 누르면 창을 다시 보여 줘요
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMain() }
        return true
    }

    // 창을 닫아도 앱은 Dock 에 남아요 (Dock 아이콘을 누르면 다시 열림)
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard engine.process != nil else { return .terminateNow }
        quitting = true
        Log.write("종료: 엔진을 끄는 중")
        engine.stop {
            Log.write("종료 완료")
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    // MARK: 창

    func makeWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.applicationNameForUserAgent = "SROADShell/\(engine.build)"
        if #available(macOS 12.3, *) { cfg.preferences.isElementFullscreenEnabled = true }
        cfg.mediaTypesRequiringUserActionForPlayback = []  // 미리 듣기 · 비교 재생이 바로 되게
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1340, height: 900), configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = false
        if #available(macOS 13.3, *) { web.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1340, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "SROAD"
        window.minSize = NSSize(width: 1000, height: 660)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.delegate = self
        window.contentView = web
        if !window.setFrameUsingName("SROADMain") { window.center() }
        window.setFrameAutosaveName("SROADMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func showLoading() {
        let html = """
        <!doctype html><meta charset="utf-8"><style>
        :root{color-scheme:light dark}
        body{margin:0;height:100vh;display:grid;place-items:center;font:600 14px -apple-system,"Apple SD Gothic Neo",sans-serif;
             background:#f2f0fb;color:#6c6a85}
        @media (prefers-color-scheme: dark){body{background:#11102a;color:#a4a1c0}}
        .w{display:flex;flex-direction:column;align-items:center;gap:14px}
        .s{width:22px;height:22px;border-radius:50%;border:2.5px solid rgba(128,128,160,.3);border-top-color:#8a6cff;animation:r .9s linear infinite}
        @keyframes r{to{transform:rotate(360deg)}}
        </style><div class="w"><div class="s"></div>SROAD 준비 중…</div>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    @objc func showMain() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func openInBrowser() {
        if let u = pageURL { NSWorkspace.shared.open(u) }
    }

    @objc func openDiag() {
        if engine.port > 0, let u = URL(string: "http://127.0.0.1:\(engine.port)/diag") { NSWorkspace.shared.open(u) }
    }

    @objc func reloadPage() {
        if let u = pageURL { web.load(URLRequest(url: u)) }
    }

    // MARK: WKWebView

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = action.request.url else { decisionHandler(.allow); return }
        let scheme = u.scheme ?? ""
        // 음원 파일을 창의 빈 곳에 떨어뜨렸을 때 그 파일로 이동하지 않게 해요 (추가는 화면이 처리해요)
        if scheme == "file" { decisionHandler(.cancel); return }
        if scheme == "about" || scheme == "data" || scheme == "blob" || u.host == "127.0.0.1" || u.host == "localhost" {
            decisionHandler(.allow)
            return
        }
        // 바깥 주소는 기본 브라우저로 열어요
        NSWorkspace.shared.open(u)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    var loggedLoad = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !loggedLoad, webView.url?.host == "127.0.0.1" else { return }
        loggedLoad = true
        Log.write("화면 열림")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard pageURL != nil, !quitting else { return }
        Log.write("⚠️ 화면을 불러오지 못함: \(error.localizedDescription) → 다시 시도")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.reloadPage() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Log.write("⚠️ 화면 프로세스가 멈춤 → 다시 불러와요")
        reloadPage()
    }

    func webViewDidClose(_ webView: WKWebView) {
        // 화면이 window.close() 를 부르면(종료 버튼) 창만 닫아요. 엔진이 끝나면 앱도 함께 끝나요.
        window.orderOut(nil)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "확인")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "확인")
        a.addButton(withTitle: "취소")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    // MARK: 메뉴

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "SROAD에 관하여", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "SROAD 가리기", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "기타 가리기", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "모두 보기", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "SROAD 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "편집")
        edit.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "실행 복귀", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "오려두기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "복사하기", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "모두 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "보기")
        let fs = view.addItem(withTitle: "전체 화면", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        view.addItem(NSMenuItem.separator())
        let browser = view.addItem(withTitle: "브라우저에서 열기", action: #selector(openInBrowser), keyEquivalent: "")
        browser.target = self
        let diag = view.addItem(withTitle: "진단 정보 보기", action: #selector(openDiag), keyEquivalent: "")
        diag.target = self
        viewItem.submenu = view

        let winItem = NSMenuItem()
        main.addItem(winItem)
        let win = NSMenu(title: "윈도우")
        win.addItem(withTitle: "최소화", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "확대/축소", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        win.addItem(withTitle: "닫기", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.addItem(NSMenuItem.separator())
        let show = win.addItem(withTitle: "SROAD 창 보기", action: #selector(showMain), keyEquivalent: "")
        show.target = self
        winItem.submenu = win

        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
}

// MARK: - 시작

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
