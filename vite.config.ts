import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Several acceptance tests intentionally simulate months or a full
    // decade. Running those CPU-heavy files in parallel makes their wall-clock
    // assertions depend on unrelated host load and can trip Vitest's 5s
    // default even though the simulation itself remains within its budgets.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
