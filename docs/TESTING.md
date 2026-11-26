# Testing

```bash
npm run check          # typecheck + lint + unit/API tests
npm run test:coverage  # with coverage; the run fails below the thresholds
npm run test:e2e       # 26 browser tests in headless Chrome (Python Playwright)
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, the unit/API tests with coverage thresholds, and the production build on every push.

## Layers

| Layer | Tool | What it proves |
|---|---|---|
| Unit (`tests/unit`) | vitest | Router correctness and labels on the real Delhi graph, risk model, journey verification, live reports, CPCB AQI breakpoints, forecast parsing, street air factors, dose maths, clean-air routing, Saans retrieval / plan / answers / prompt, manifest integrity |
| API (`tests/api`) | vitest + real HTTP server | Journeys, privacy deletion, reviews, reports, rate limits, `/api/air`, `/api/assistant` with fake Google services (key mode, Vertex mode, model fallback, quotas, circuit breaker, cache), security headers, CSP, path traversal, ETag |
| End to end (`tests/e2e`) | Playwright, phone 390×844 and desktop | First run, search, directions, night routing, live navigation with mocked GPS, SOS check-in, offline PWA, accessibility names and 360 px layout, live reports, voice guidance, AQI card, Saans chat, family profile, clean-air routes, air reports, nearby places without coordinates leaving the phone, street air layer |

## Coverage (shared/ + server/)

Statements ≈ 91 %, branches ≈ 80 %, functions ≈ 92 %, lines ≈ 95 %. Thresholds enforced: 85 / 75 / 85 / 90.

## Conventions

* Every test is named with a test-case id (`TC-150 …`) that maps to `docs/05-test-cases.md` and a requirement in `docs/02-requirements.md`.
* Tests run in `TZ=UTC` to prove time logic uses India Standard Time explicitly.
* Network services are faked in tests (`fetch` injection in `server/ai.ts`, `tests/e2e/airfix.py`), so tests are deterministic and need no keys.
