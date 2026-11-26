# Security

## Reporting
Please report vulnerabilities privately to the maintainer (GitHub: @unknown8575) rather than in a public issue.

## Threat model and controls

| Threat | Control | Code / test |
|---|---|---|
| Leaked API keys | No key in the client bundle or the repository. On Cloud Run, Gemini runs through Vertex AI with the service account (metadata-server token), so no key exists at all. Keys, when used, travel in headers, never URLs. | `server/ai.ts`; TC-191, TC-192, TC-197 |
| Prompt injection | User text is stripped of control/zero-width characters and fake tags, wrapped in `<user_question>`, and the system instruction says to treat it as data; the model may only use numbers from code-computed FACTS. Output is rendered as text nodes, never HTML. | `shared/saans/assistant.ts` `sanitizeUserText`; TC-200 |
| Cost abuse of the assistant | 20 questions / 10 min per phone, 60 / hour per network address (taken from the address Google's front end appends, so it can't be forged), a server-wide daily cap, a circuit breaker after 3 failures, a 10-minute answer cache. | `server/app.ts` `aiLimit`, `server/ai.ts`; TC-194, TC-196, TC-198, TC-199 |
| Malformed or hostile input | Every API field is type-checked and clamped (family profile, air readings, places, routes, GPS fixes); bodies capped at 512 KB; unknown kinds rejected. | `cleanFamily`, `cleanAir`, journey/report validators; TC-195, server tests |
| XSS / clickjacking / sniffing | Content-Security-Policy (`script-src 'self'`, no `unsafe-eval`, `object-src 'none'`, `frame-ancestors 'none'`) as a header and a `<meta>` for static hosting; `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`; `Referrer-Policy: no-referrer`; Permissions-Policy allows only geolocation and microphone. | `server/app.ts` `SECURITY_HEADERS`, `CSP`; `vite.config.ts`; TC-201 |
| Path traversal | Static paths are decoded safely (400 on malformed escapes) and must resolve inside the web root (separator-aware check). | `serveStatic`; TC-202 |
| Tampered data download | Map data is pinned to a commit and every file's SHA-256 is verified before use. | `scripts/fetch-data.mjs`, `data-manifest.json`; TC-185, TC-186 |
| Cross-origin misuse of the API | CORS only for listed origins (the website and the native apps). | `server/app.ts` |
| Location privacy | GPS never stored after a trip; trip data deleted at the end; votes and reports keyed by one-way pseudonyms; air asked for a ~10 km cell; nearby-place questions send names and distances only. | `docs/10-privacy.md`; TC-130–134, TC-149 |
| Transport | HTTPS only on Cloud Run with HSTS. | `server/app.ts` |
