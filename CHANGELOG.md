# Changelog

All notable changes to `asqav-chatbase` are listed here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer](https://semver.org/) and track the `package.json` version.

## [Unreleased]

## [0.1.0] - 2026-05-31

Initial release. `handleChatbaseAction` and `expressHandler` receive a Chatbase Custom Action call, sign the intended action through Asqav, and forward to the real downstream URL only when allowed. A refused action returns a blocked JSON response and never reaches the downstream. Fail-closed by default.
