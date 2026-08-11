# Northstar for iOS

The web app in `public/` is already built to feel native on iPhone: install it
from Safari via **Share → Add to Home Screen** and it runs standalone — full
screen, safe-area aware, star icon on the home screen, no browser chrome.
That is the fastest way to have Northstar on a phone today, no App Store
required.

This folder is the next step: a **native SwiftUI shell** for the App Store.
It wraps the same web app in a `WKWebView` — the standard v1 pattern for
shipping a web product natively (settings, accounts, tabs, and the story all
work unchanged inside it).

## Honest status

These Swift sources were written on a Linux build machine, where Xcode does
not exist — they follow the standard SwiftUI/WebKit APIs but **have not been
compiled**. Treat them as a scaffold to drop into Xcode, not a shipped app.

## Assemble in Xcode (on a Mac)

1. Xcode → **File → New → Project → iOS → App**.
   - Product name: `Northstar` · Interface: SwiftUI · Language: Swift.
2. Delete the generated `ContentView.swift`. Drag the two files from
   `ios/Northstar/` into the project.
3. In `NorthstarApp.swift`, set `appURL` to where the backend runs:
   - Simulator against a local server: `http://127.0.0.1:3000` — also add an
     App Transport Security exception for localhost in Info.plist
     (`NSAppTransportSecurity → NSAllowsLocalNetworking: YES`).
   - A real deployment: your `https://…` URL, no exception needed.
4. Run. The story, search, tabs, history, and settings all work inside the
   shell.

## Later, when it's worth it

The API is clean JSON (`/v1/search`, `/v1/session`, `/v1/settings`, …), so a
fully native SwiftUI search UI can replace the web view screen by screen
without touching the backend.
