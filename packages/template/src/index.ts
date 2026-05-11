import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { Cli, z } from 'incur'

const app = new OpenAPIHono()

const search = createRoute({
  method: 'get',
  path: '/search',
  request: {
    query: z.object({
      q: z.string().describe('Search query'),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }),
  },
  responses: {
    200: {
      description: 'Search results',
      content: {
        'application/json': {
          schema: z.object({
            results: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
              }),
            ),
          }),
        },
      },
    },
    502: {
      description: 'Upstream API error',
      content: {
        'application/json': {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
})

app.openapi(search, async (c) => {
  const { q, limit } = c.req.valid('query')
  const url = new URL('https://example.com/api/search')
  url.searchParams.set('q', q)
  url.searchParams.set('limit', String(limit))

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'my-plugin (https://github.com/<owner>/<repo>)',
      },
    })

    if (!response.ok) {
      return c.json({ error: `upstream returned ${response.status}` }, 502)
    }

    const results = await response.json()
    return c.json({ results })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return c.json({ error: 'upstream request timed out' }, 502)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
})

const spec = app.getOpenAPIDocument({
  openapi: '3.1.0',
  info: { title: 'my-plugin', version: '0.1.0' },
})

const cli = Cli.create('my-plugin', {
  description: 'Describe what this plugin does in one sentence.',
}).command('api', {
  description: 'Call the website API',
  fetch: app.fetch,
  openapi: spec,
})

export default cli
