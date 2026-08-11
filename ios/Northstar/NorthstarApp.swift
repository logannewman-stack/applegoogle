import SwiftUI

@main
struct NorthstarApp: App {
    /// Where the Northstar backend lives. For the simulator against a local
    /// `npm start`, use http://127.0.0.1:3000 (with the ATS localhost
    /// exception noted in ios/README.md). For production, your https URL.
    let appURL = URL(string: "http://127.0.0.1:3000")!

    var body: some Scene {
        WindowGroup {
            NorthstarWebView(url: appURL)
                .ignoresSafeArea()
                .preferredColorScheme(nil) // follow the system; the web app handles both themes
        }
    }
}
