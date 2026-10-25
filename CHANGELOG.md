# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-25

### Added

- First public release.
- Eight read-only MCP tools for the Oura API v2: `daily_sleep`, `sleep`, `daily_readiness`, `daily_activity`, `daily_stress`, `workouts`, `heartrate` and `personal_info`. Date-based tools take `start_date`/`end_date` and default to the last 7 days, in your own time zone.
- A remote MCP endpoint (stateless Streamable HTTP) for Claude custom connectors, protected by an unguessable secret in the URL path.
- A private setup page with a live connection test, and an Oura OAuth 2.0 sign-in with PKCE, signed state and browser binding.
- Encrypted storage (AES-256-GCM) of Oura's single-use refresh tokens in a private Vercel Blob store, with automatic renewal.
- Error logging that redacts tokens and secrets.
- One-click deployment to Vercel (Deploy button with a private Blob store), CI (lint, tests, dependency audit, gitleaks), CodeQL and Dependabot.
