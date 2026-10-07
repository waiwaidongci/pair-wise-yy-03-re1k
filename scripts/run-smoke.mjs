// Runs scripts/smoke.mjs through Vite's SSR transform so it can import .ts source.
import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

try {
  await server.ssrLoadModule('/scripts/smoke.mjs')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await server.close()
}
