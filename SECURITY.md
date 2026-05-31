# Security Policy

## Reporting Vulnerabilities

Email info@asqav.com with details. We will respond within 48 hours.

Do not open public issues for security vulnerabilities.

## Supported Versions

Only the latest published release is supported.

## Scope

This repository contains asqav-chatbase, the Chatbase Custom Actions proxy connector for Asqav.

Report issues that affect:
- The sign-then-forward pre-execution gate
- Bypasses that let a refused action reach the downstream
- Payload tampering before submission to the Asqav API or the downstream

Cryptographic signing runs server-side via the Asqav API. Report signing or key-handling issues against [asqav-sdk](https://github.com/jagmarques/asqav-sdk).
