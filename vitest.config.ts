import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/unit/**/*.test.ts', 'tests/api/**/*.test.ts', 'tests/ui/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    // run with a non-Indian timezone to prove all time logic uses IST
    env: { TZ: 'UTC' },
    pool: 'forks',
    coverage: {
      provider: 'v8',
      // the logic that decides things (routing, air model, risk, Saans, server) and the pure UI renderers
      include: [
        'shared/**/*.ts',
        'server/**/*.ts',
        'web/src/dom.ts',
        'web/src/airui.ts',
        'web/src/search.ts',
        'web/src/messages.ts',
        'web/src/store.ts',
      ],
      exclude: ['server/main.ts', 'server/notify.ts'],
      reporter: ['text-summary', 'text'],
      // the build fails if coverage drops below these
      thresholds: { statements: 85, branches: 75, functions: 85, lines: 90 },
    },
  },
});
