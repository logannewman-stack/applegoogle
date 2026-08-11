import SwiftUI
import WebKit

/// The SwiftUI wrapper around the Northstar web app.
///
/// Cookies (the ns_session sign-in) and localStorage (tabs, settings, the
/// onboarding flag) persist in the default website data store, so the app
/// remembers the user between launches exactly like the web does.
struct NorthstarWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        context.coordinator.webView = webView // wired now, so refresh works even if the first load fails

        // Pull to refresh, like every native list.
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.reload(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?

        @objc func reload(_ sender: UIRefreshControl) {
            webView?.reload()
            sender.endRefreshing()
        }

        // Result links (target="_blank" or off-origin) open in the system
        // browser; the app itself stays on the Northstar origin.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let appHost = webView.url?.host
            let isNewWindow = navigationAction.targetFrame == nil // target="_blank"
            let isOffOrigin = navigationAction.navigationType == .linkActivated
                && target.host != nil && target.host != appHost
            if isNewWindow || isOffOrigin {
                UIApplication.shared.open(target)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        // WKWebView drops target="_blank" navigations unless a UI delegate
        // handles the new-window request — send it to the system browser.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                UIApplication.shared.open(url)
            }
            return nil
        }
    }
}
