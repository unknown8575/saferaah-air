# Testing

```bash
npm run check          # typecheck + lint + unit/API tests
npm run test:coverage  # with coverage; the run fails below the thresholds
npm run test:e2e       # 27 browser cases in headless Chrome (Python Playwright), incl. an axe-core WCAG 2.1 AA audit
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, the unit/API/UI tests with coverage thresholds, the production build, and an end-to-end smoke job (first run, offline PWA, air home, Saans, clean-air routes and the axe-core WCAG audit) in headless Chrome on every push.

## Layers

| Layer | Tool | What it proves |
|---|---|---|
| Unit (`tests/unit`) | vitest | Geometry, router correctness, labels and de-duplication on the real Delhi graph, risk model, journey verification, live reports, CPCB AQI breakpoints, forecast parsing, street air factors, dose maths, clean-air routing, Saans retrieval / plan / answers / prompt, manifest integrity |
| UI (`tests/ui`) | vitest + happy-dom | The air-first home (one `h1`, 24-hour AQI basis, weather, smog-trap banner, plan steps, buttons), honest empty state, route air lines, the time / safety / air radio group, the route air section and its night trade-off, offline place search (industrial areas, nicknames, de-duplication), on-device settings key, phone normalisation, pre-filled messages |
| API (`tests/api`) | vitest + real HTTP server | Journeys, privacy deletion, reviews, reports, rate limits, `/api/air`, `/api/assistant` with fake Google services (key mode, Vertex mode, model fallback, quotas, circuit breaker, cache), thinking settings and their fallback, security headers, CSP, path traversal, ETag, constant-time tokens, the persistent daily AI cap, SMS relay limits, production CORS |
| End to end (`tests/e2e`) | Playwright, phone 390×844 and desktop | First run, search, directions, night routing, live navigation with mocked GPS, SOS check-in, offline PWA, accessibility names and 360 px layout, live reports, voice guidance, AQI card, Saans chat, family profile, clean-air routes, air reports, nearby places without coordinates leaving the phone, street air layer, **axe-core WCAG 2.1 AA audit** of the main screens in day and night themes (TC-150) |

## Coverage (shared/, server/ and the pure UI modules)

165 unit, UI and API tests. Statements ≈ 94 %, branches ≈ 83 %, functions ≈ 95 %, lines ≈ 97 %. Thresholds enforced: 85 / 75 / 85 / 90.

## Conventions

* Every test is named with a test-case id (`TC-150 …`) that maps to `docs/05-test-cases.md` and a requirement in `docs/02-requirements.md`.
* Tests run in `TZ=UTC` to prove time logic uses India Standard Time explicitly.
* Network services are faked in tests (`fetch` injection in `server/ai.ts`, `tests/e2e/airfix.py`), so tests are deterministic and need no keys.
