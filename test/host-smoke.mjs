// Host-side functional smoke test for doubao-media.
// Runs the real plugin module against a stub Ark server and a minimal Cordis ctx.
import http from 'node:http'
import { Writable, Readable } from 'node:stream'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const MP4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(64, 7)])

let failures = 0
function check(name, condition, extra) {
  if (condition) {
    console.log('  ok  ' + name)
    return
  }
  failures += 1
  console.log('FAIL  ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)))
}

function startStub() {
  let polls = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (status, payload) => {
      const body = Buffer.from(JSON.stringify(payload))
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) })
      res.end(body)
    }
    if (req.method === 'POST' && url.pathname === '/api/v3/images/generations') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (body.prompt === 'boom') {
          json(400, { error: { code: 'InvalidParameter', message: 'prompt rejected by stub' } })
          return
        }
        json(200, {
          model: body.model,
          data: [{ url: `http://127.0.0.1:${server.address().port}/file.png`, size: '2048x2048', output_format: 'png' }],
        })
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/v3/contents/generations/tasks') {
      polls = 0
      req.resume()
      req.on('end', () => json(200, { id: 'cgt-stub-1' }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/v3/contents/generations/tasks/cgt-stub-1') {
      polls += 1
      if (polls < 2) {
        json(200, { id: 'cgt-stub-1', status: 'running', model: 'doubao-seedance-1-0-pro-250528' })
        return
      }
      json(200, {
        id: 'cgt-stub-1',
        status: 'succeeded',
        model: 'doubao-seedance-1-0-pro-250528',
        content: { video_url: `http://127.0.0.1:${server.address().port}/file.mp4` },
        duration: 5,
        resolution: '720p',
        ratio: '16:9',
      })
      return
    }
    if (url.pathname === '/file.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) })
      res.end(PNG)
      return
    }
    if (url.pathname === '/file.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length) })
      res.end(MP4)
      return
    }
    json(404, { error: { code: 'NotFound', message: req.url } })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function makeContext(baseUrl, workDir) {
  const tools = new Map()
  const routes = new Map()
  const stored = new Map()
  const disposers = []
  const credentials = {
    async resolve(ref) {
      return stored.has(ref) ? { value: stored.get(ref), source: 'file' } : undefined
    },
    async describe(ref) {
      return { configured: stored.has(ref), source: stored.has(ref) ? 'file' : undefined, writable: true }
    },
    async set(ref, value) {
      stored.set(ref, value)
    },
    async unset(ref) {
      stored.delete(ref)
    },
  }
  const workingDirectory = {
    defaultDirectory: workDir,
    async ensure() {
      return workDir
    },
  }
  const webCtx = {
    effect(fn) {
      disposers.push(fn())
    },
    webServer: {
      getOrigin() {
        return 'http://127.0.0.1:1'
      },
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  const ctx = {
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'workingDirectory') return workingDirectory
      if (name === 'agents') return { get: () => ({ id: 'session-1', session: { id: 'session-1' } }) }
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workingDirectory,
    inject(names, callback) {
      if (names.includes('webServer')) callback(webCtx)
      return () => {}
    },
  }
  apply(ctx, { baseUrl, outputDir: join(workDir, 'out') })
  return { tools, routes, credentials, workDir }
}

function jsonRequest(handler, { method = 'GET', url, body, headers = {} }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = Readable.from(payload)
    req.method = method
    req.url = url
    req.headers = { 'content-type': 'application/json', ...headers }
    const chunks = []
    const headersSeen = {}
    const res = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk)
        done()
      },
    })
    res.writeHead = (status, extra) => {
      res.statusCode = status
      Object.assign(headersSeen, extra || {})
      return res
    }
    res.on('finish', () => {
      const raw = Buffer.concat(chunks)
      let data
      try {
        data = JSON.parse(raw.toString('utf8'))
      } catch {
        data = undefined
      }
      resolve({ status: res.statusCode, headers: headersSeen, data, bytes: raw })
    })
    Promise.resolve(handler(req, res)).catch((error) => {
      resolve({ status: 500, headers: {}, data: { ok: false, error: String(error) }, bytes: Buffer.alloc(0) })
    })
  })
}

function mediaRequest(handler, url, headers = {}) {
  return new Promise((resolve) => {
    const req = Readable.from([])
    req.method = 'GET'
    req.url = url
    req.headers = headers
    const chunks = []
    const headersSeen = {}
    const res = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk)
        done()
      },
    })
    res.writeHead = (status, extra) => {
      res.statusCode = status
      Object.assign(headersSeen, extra || {})
      return res
    }
    res.on('finish', () => resolve({ status: res.statusCode, headers: headersSeen, bytes: Buffer.concat(chunks) }))
    Promise.resolve(handler(req, res)).catch((error) =>
      resolve({ status: 500, headers: {}, bytes: Buffer.from(String(error)) }),
    )
  })
}

const stub = await startStub()
const baseUrl = `http://127.0.0.1:${stub.address().port}/api/v3`
const workDir = await mkdtemp(join(tmpdir(), 'doubao-smoke-'))
const { tools, routes } = makeContext(baseUrl, workDir)

console.log('plugin surface')
check('registers doubao_image', tools.has('doubao_image'))
check('registers doubao_video', tools.has('doubao_video'))
check('registers /doubao-api route', routes.has('/doubao-api'))

const imageTool = tools.get('doubao_image')
const videoTool = tools.get('doubao_video')
const agent = { id: 'session-1', session: { id: 'session-1' } }
const signal = new AbortController().signal
const handler = routes.get('/doubao-api')

console.log('http routes: key + state')
let response = await jsonRequest(handler, { url: '/doubao-api/state' })
check('state needs no key before configuration', response.status === 200 && response.data.configured === false, response.data)

response = await jsonRequest(handler, { method: 'POST', url: '/doubao-api/key', body: { apiKey: 'ark-test-key' } })
check('key route stores the credential', response.status === 200 && response.data.configured === true, response.data)

console.log('tool: doubao_image')
const imageValue = await imageTool.execute({ prompt: '一只在雪地里的柴犬' }, { agent, signal })
check('returns a .png path', imageValue.absolutePath.endsWith('.png'), imageValue)
check('relative path stays inside workspace', imageValue.path.startsWith('out/'), imageValue.path)
check('reports 2048x2048', imageValue.width === 2048 && imageValue.height === 2048, imageValue)
const imageBytes = await readFile(imageValue.absolutePath)
check('writes the stub image bytes', imageBytes.equals(PNG))
const rendered = imageTool.output.render({ prompt: 'x' }, imageValue)
check('renders one text block mentioning the path', rendered[0].text.includes(imageValue.absolutePath))

console.log('tool: doubao_video')
const videoValue = await videoTool.execute({ prompt: '海浪拍打礁石', duration: 5, ratio: '16:9', resolution: '720p' }, { agent, signal })
check('returns an .mp4 path', videoValue.absolutePath.endsWith('.mp4'), videoValue)
check('carries duration + resolution', videoValue.duration === 5 && videoValue.resolution === '720p', videoValue)
const videoBytes = await readFile(videoValue.absolutePath)
check('writes the stub video bytes', videoBytes.equals(MP4))

console.log('http routes: generate + media')
response = await jsonRequest(handler, { method: 'POST', url: '/doubao-api/generate', body: { kind: 'image', prompt: '面板测试' } })
check('generate image returns ok', response.status === 200 && response.data.ok === true, response.data)
check('generate image returns media url + path', Boolean(response.data.url) && Boolean(response.data.path), response.data)
const mediaPath = response.data.url
const absolute = response.data.absolutePath
check('media file exists on disk', (await stat(absolute)).isFile())

let media = await mediaRequest(handler, mediaPath)
check('serves media with image/png', media.status === 200 && media.headers['content-type'] === 'image/png', media.headers)
check('serves exact bytes', media.bytes.equals(PNG))

media = await mediaRequest(handler, mediaPath, { range: 'bytes=0-7' })
check('serves range with 206', media.status === 206 && media.headers['content-range'] === `bytes 0-7/${PNG.length}`, media.headers)
check('range body length is 8', media.bytes.length === 8)

response = await jsonRequest(handler, { method: 'POST', url: '/doubao-api/generate', body: { kind: 'video', prompt: '视频面板', duration: 5 } })
check('generate video returns task id', response.data.ok === true && Boolean(response.data.taskId), response.data)
const taskId = response.data.taskId
let status = null
for (let attempt = 0; attempt < 5; attempt += 1) {
  response = await jsonRequest(handler, { url: '/doubao-api/video?id=' + encodeURIComponent(taskId) })
  status = response.data
  if (status.status === 'succeeded') break
}
check('video polling settles to succeeded', status.status === 'succeeded', status)
check('video result carries media url', Boolean(status.url), status)
media = await mediaRequest(handler, status.url)
check('serves video/mp4', media.status === 200 && media.headers['content-type'] === 'video/mp4', media.headers)

console.log('failure paths')
response = await jsonRequest(handler, { method: 'POST', url: '/doubao-api/generate', body: { prompt: '   ' } })
check('rejects blank prompt', response.data.ok === false && /提示词/.test(response.data.error), response.data)

response = await jsonRequest(handler, { method: 'POST', url: '/doubao-api/generate', body: { kind: 'image', prompt: 'boom' } })
check('surfaces Volcengine error text', response.data.ok === false && /InvalidParameter/.test(response.data.error), response.data)

response = await jsonRequest(handler, { method: 'POST', url: '/doubao-api/key', body: { apiKey: 'x' }, headers: { origin: 'https://evil.example' } })
check('rejects a foreign origin', response.data.ok === false && /本机/.test(response.data.error), response.data)

console.log('entry fallback: pay-as-you-go base rejects a plan key')
{
  const planStub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (status, payload) => {
      const body = Buffer.from(JSON.stringify(payload))
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) })
      res.end(body)
    }
    if (url.pathname.startsWith('/api/v3/')) {
      json(401, { error: { code: 'AuthenticationError', message: 'The API key or AK/SK in the request is missing or invalid.' } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/plan/v3/images/generations') {
      req.resume()
      req.on('end', () => json(200, { data: [{ url: `http://127.0.0.1:${planStub.address().port}/file.png`, size: '2048x2048', output_format: 'png' }] }))
      return
    }
    if (url.pathname === '/file.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) })
      res.end(PNG)
      return
    }
    json(404, { error: { code: 'NotFound', message: req.url } })
  })
  await new Promise((resolve) => planStub.listen(0, '127.0.0.1', resolve))
  const planBase = `http://127.0.0.1:${planStub.address().port}/api/v3`
  const planDir = await mkdtemp(join(tmpdir(), 'doubao-plan-'))
  const planContext = makeContext(planBase, planDir)
  await planContext.credentials.set('ARK_API_KEY', 'plan-key')
  const value = await planContext.tools.get('doubao_image').execute({ prompt: '入口切换' }, { agent, signal })
  check('falls back to the /api/plan entry', value.absolutePath.endsWith('.png'), value)
  const state = await jsonRequest(planContext.routes.get('/doubao-api'), { url: '/doubao-api/state' })
  check('state reports the plan entry', state.data.entry === 'plan', state.data.entry)
  check('served the fallback image', (await readFile(value.absolutePath)).equals(PNG))
  await new Promise((resolve) => planStub.close(resolve))
}

await new Promise((resolve) => stub.close(resolve))
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
