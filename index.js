/**
 * 豆包创作 · 火山方舟（Volcengine Ark）图片 / 视频生成插件的 Host 半。
 *
 * 一份能力，两个调用方：
 * - Agent 工具：`doubao_image`、`doubao_video` 由模型自行调用；
 * - Web UI：`/doubao-api/*` 同源路由，供 composer 下方的「豆包创作」面板调用。
 *
 * 两条路径共用下面的 generateImage / createVideoTask / pollVideoTask，只有
 * 输出目录的解析方式不同（会话工作目录 vs 默认工作目录）。
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { join, relative, isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream'

/** 凭据键（同时作为环境变量名）。 */
const CREDENTIAL_REF = 'ARK_API_KEY'
/** 本插件注册的同源路由前缀。 */
const MEDIA_ROUTE = '/doubao-api'
/** 已生成文件的内存索引上限，超过后按插入顺序淘汰。 */
const MEDIA_CACHE_LIMIT = 200

/** 图片模型目录（可在 cordis.patch.yml 的 config 中覆盖默认模型）。 */
const IMAGE_MODELS = [
  { id: 'doubao-seedream-5-0-pro-260628', label: 'Seedream 5.0 Pro' },
  { id: 'doubao-seedream-5-0-flash-260915', label: 'Seedream 5.0 Flash' },
  { id: 'doubao-seedream-5-0-260128', label: 'Seedream 5.0 Lite（即将下线）' },
  { id: 'doubao-seedream-4-5-251128', label: 'Seedream 4.5（即将下线）' },
]

/** 视频模型目录。 */
const VIDEO_MODELS = [
  { id: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5' },
  { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0' },
  { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast' },
  { id: 'doubao-seedance-2-0-mini-260615', label: 'Seedance 2.0 Mini' },
  { id: 'doubao-seedance-1-0-pro-fast-251015', label: 'Seedance 1.0 Pro Fast（即将下线）' },
  { id: 'doubao-seedance-1-0-pro-250528', label: 'Seedance 1.0 Pro（即将下线）' },
]

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}

/** 默认入口（按量付费）；Agent Plan 用户把 baseUrl 指到同一主机的 `/api/plan/v3`，插件会自动识别并互为备选。 */
const ARK_ENTRY = 'https://ark.cn-beijing.volces.com/api/v3'

/** 图片生成工具与 Web 请求共用的排队上限。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000
/** 视频任务轮询上限。 */
const DEFAULT_VIDEO_TIMEOUT_MS = 900_000

/** @param {unknown} value @param {string} fallback */
function textOf(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/** @param {unknown} value @param {number} fallback */
function positiveOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const imageModel = textOf(raw.imageModel, IMAGE_MODELS[0].id)
  const videoModel = textOf(raw.videoModel, VIDEO_MODELS[0].id)
  return {
    baseUrl: textOf(raw.baseUrl, ARK_ENTRY).replace(/\/+$/, ''),
    apiKey: textOf(raw.apiKey, ''),
    imageModel,
    videoModel,
    imageSize: textOf(raw.imageSize, '2K'),
    outputDir: textOf(raw.outputDir, ''),
    requestTimeoutMs: positiveOf(raw.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    videoTimeoutMs: positiveOf(raw.videoTimeoutMs, DEFAULT_VIDEO_TIMEOUT_MS),
    imageModels: mergeModels(IMAGE_MODELS, imageModel),
    videoModels: mergeModels(VIDEO_MODELS, videoModel),
  }
}

function mergeModels(catalog, current) {
  if (catalog.some((entry) => entry.id === current)) return catalog.slice()
  return [{ id: current, label: current }, ...catalog]
}

/** @param {unknown} error */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve(undefined)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 调用方舟 JSON 接口。
 * @param {object} input
 * @param {string} input.url
 * @param {'GET' | 'POST'} [input.method]
 * @param {string} [input.apiKey]
 * @param {unknown} [input.body]
 * @param {number} [input.timeoutMs]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<any>}
 */
function requestJson(input) {
  const method = input.method ?? 'GET'
  const timeoutMs = input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(input.url)
    } catch (error) {
      reject(new Error(`无效的方舟接口地址：${input.url}`))
      return
    }
    const transport = target.protocol === 'http:' ? http : https
    const payload = input.body === undefined ? null : Buffer.from(JSON.stringify(input.body), 'utf8')
    let settled = false
    let timer
    const done = (fn, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      input.signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }
    const request = transport.request(
      target,
      {
        method,
        headers: {
          accept: 'application/json',
          ...(payload === null
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(payload.length) }),
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', (error) => done(reject, error))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const status = response.statusCode ?? 0
          let json
          try {
            json = raw.length > 0 ? JSON.parse(raw) : {}
          } catch {
            json = undefined
          }
          if (status < 200 || status >= 300) {
            const detail =
              json && json.error
                ? [json.error.code, json.error.message].filter(Boolean).join(': ')
                : raw.slice(0, 400)
            done(
              reject,
              new Error(`方舟接口 ${method} ${target.pathname} 返回 HTTP ${status}：${detail || '无响应内容'}`),
            )
            return
          }
          if (json === undefined) {
            done(reject, new Error(`方舟接口 ${method} ${target.pathname} 返回了非 JSON 内容`))
            return
          }
          done(resolve, json)
        })
      },
    )
    timer = setTimeout(() => {
      done(reject, new Error(`调用方舟接口超时（${Math.round(timeoutMs / 1000)} 秒）`))
      request.destroy()
    }, timeoutMs)
    const onAbort = () => {
      done(reject, new Error('已取消'))
      request.destroy()
    }
    if (input.signal) {
      if (input.signal.aborted) {
        done(reject, new Error('已取消'))
        return
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
    }
    request.on('error', (error) => done(reject, error))
    if (payload !== null) request.write(payload)
    request.end()
  })
}

/**
 * 下载生成结果到本地文件，支持一次跳转。
 * @param {string} url
 * @param {string} target
 * @param {AbortSignal} [signal]
 * @param {number} [redirects]
 * @returns {Promise<void>}
 */
function downloadToFile(url, target, signal, redirects = 3) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (error) {
      reject(new Error('生成结果地址无效'))
      return
    }
    const transport = parsed.protocol === 'http:' ? http : https
    const onAbort = () => {
      request.destroy(new Error('已取消'))
      unlink(target).catch(() => {})
      finish(() => reject(new Error('已取消')))
    }
    const finish = (fn) => {
      signal?.removeEventListener?.('abort', onAbort)
      fn()
    }
    const request = transport.get(parsed, { headers: { accept: '*/*' } }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume()
        downloadToFile(new URL(response.headers.location, parsed).toString(), target, signal, redirects - 1).then(
          () => finish(() => resolve()),
          (error) => finish(() => reject(error)),
        )
        return
      }
      if (status !== 200) {
        response.resume()
        finish(() => reject(new Error(`下载生成结果失败：HTTP ${status}`)))
        return
      }
      const output = createWriteStream(target)
      pipeline(response, output, (error) => {
        if (error) {
          unlink(target).catch(() => {})
          finish(() => reject(error instanceof Error ? error : new Error(String(error))))
          return
        }
        finish(() => resolve())
      })
    })
    request.on('error', (error) => finish(() => reject(error)))
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** 由提示词生成稳定的文件名片段。 */
function slugOf(prompt, fallback) {
  const slug = String(prompt ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug.length > 0 ? slug : fallback
}

function stampOf(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function extensionOf(url, fallback) {
  try {
    const ext = new URL(url).pathname.match(/(\.[a-z0-9]{2,5})$/i)
    return ext ? ext[1].toLowerCase() : fallback
  } catch {
    return fallback
  }
}

/** @param {string} file */
function mimeOf(file) {
  const match = file.toLowerCase().match(/(\.[a-z0-9]{2,5})$/)
  return (match && MIME_BY_EXT[match[1]]) || 'application/octet-stream'
}

function parseSize(size) {
  const match = typeof size === 'string' ? size.match(/^(\d{2,5})x(\d{2,5})$/) : null
  if (!match) return {}
  return { width: Number(match[1]), height: Number(match[2]) }
}

/**
 * 插件依赖：工具注册与（用于解析会话工作目录的）工作目录服务。
 * webServer 是可选的，在 apply 内通过 ctx.inject 挂载。
 */
export const inject = ['tools', 'workingDirectory']

/**
 * Host 半入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  /** @type {Map<string, { path: string, mime: string }>} */
  const media = new Map()
  /** @type {Map<string, { prompt: string, sessionId?: string }>} */
  const videoJobs = new Map()
  /** @type {Map<string, any>} */
  const videoResults = new Map()

  /** 当前生效的入口；首次鉴权失败时自动切到另一个入口并记住。 */
  let activeBase = settings.baseUrl

  /** 同一主机下 `/api/v3` 与 `/api/plan/v3` 互为备选入口（Agent Plan 专属入口带 `/plan`）。 */
  function pairedEntry(base) {
    if (base.includes('/api/plan/')) return base.replace('/api/plan/', '/api/')
    if (base.includes('/api/v3')) return base.replace('/api/v3', '/api/plan/v3')
    return undefined
  }

  const entryCandidates = (base) => {
    const pair = [base, pairedEntry(base)].filter((entry) => typeof entry === 'string')
    return pair.filter((entry, index) => pair.indexOf(entry) === index)
  }
  const isPlanEntry = (base) => base.includes('/api/plan/')

  const credentials = () => {
    const service = ctx.get('credentials')
    return service && typeof service.resolve === 'function' ? service : undefined
  }

  /** 依次解析：本机凭据文件 → config.apiKey → 环境变量。 */
  async function resolveApiKey() {
    const store = credentials()
    if (store) {
      try {
        const info = await store.describe(CREDENTIAL_REF)
        if (info && info.configured && info.source === 'file') {
          const resolved = await store.resolve(CREDENTIAL_REF)
          if (resolved && resolved.value) return resolved.value
        }
      } catch {
        /* 凭据服务不可用时继续走后面的来源 */
      }
    }
    if (settings.apiKey) return settings.apiKey
    if (store) {
      try {
        const resolved = await store.resolve(CREDENTIAL_REF)
        if (resolved && resolved.value) return resolved.value
      } catch {
        /* 忽略 */
      }
    }
    const env = process.env[CREDENTIAL_REF] || process.env.DOUBAO_API_KEY
    if (typeof env === 'string' && env.trim().length > 0) return env.trim()
    throw new Error(
      `未配置火山方舟 API Key。可以在「豆包创作」面板中保存，或设置环境变量 ${CREDENTIAL_REF}（火山方舟控制台 → API Key 管理）。`,
    )
  }

  async function keyState() {
    const store = credentials()
    if (store) {
      try {
        const info = await store.describe(CREDENTIAL_REF)
        if (info && info.configured) {
          return { configured: true, source: info.source ?? 'unknown', writable: info.writable !== false }
        }
      } catch {
        /* 忽略 */
      }
    }
    if (settings.apiKey) return { configured: true, source: 'config', writable: true }
    const env = process.env[CREDENTIAL_REF] || process.env.DOUBAO_API_KEY
    if (typeof env === 'string' && env.trim().length > 0) return { configured: true, source: 'env', writable: true }
    return { configured: false, source: 'none', writable: Boolean(store) }
  }

  /** 输出目录：config.outputDir 优先，否则工作目录下的 doubao/。 */
  function outputDirFor(base) {
    if (settings.outputDir) return isAbsolute(settings.outputDir) ? settings.outputDir : join(base, settings.outputDir)
    return join(base, 'doubao')
  }

  async function saveFromUrl(url, dir, ext, prompt, signal) {
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${stampOf()}-${slugOf(prompt, 'doubao')}-${randomBytes(2).toString('hex')}.${ext}`)
    await downloadToFile(url, file, signal)
    const info = await stat(file)
    if (!info.isFile() || info.size === 0) throw new Error('生成结果下载为空文件，请重试')
    return { file, bytes: info.size }
  }

  function rememberMedia(file) {
    const id = randomBytes(12).toString('hex')
    media.set(id, { path: file, mime: mimeOf(file) })
    while (media.size > MEDIA_CACHE_LIMIT) {
      const oldest = media.keys().next().value
      if (oldest === undefined) break
      media.delete(oldest)
    }
    return { id, url: `${MEDIA_ROUTE}/media/${id}` }
  }

  /** 同一个请求先走当前入口；401/403 时换另一个入口重试一次。 */
  async function arkRequest(pathname, options) {
    const candidates = entryCandidates(activeBase)
    let lastError
    for (const base of candidates) {
      try {
        const result = await requestJson({ url: `${base}${pathname}`, ...options })
        if (base !== activeBase) activeBase = base
        return result
      } catch (error) {
        lastError = error
        if (!/HTTP (401|403)|AuthenticationError|API key or AK\/SK/i.test(messageOf(error))) throw error
      }
    }
    throw lastError
  }

  async function generateImage(input) {
    const apiKey = await resolveApiKey()
    const model = textOf(input.model, settings.imageModel)
    const size = textOf(input.size, settings.imageSize)
    const body = { model, prompt: input.prompt, size, response_format: 'url', watermark: false }
    if (/^doubao-seedream-5/i.test(model)) body.output_format = 'png'
    const json = await arkRequest('/images/generations', {
      method: 'POST',
      apiKey,
      body,
      signal: input.signal,
      timeoutMs: settings.requestTimeoutMs,
    })
    const item = Array.isArray(json?.data) ? json.data[0] : undefined
    if (!item || typeof item.url !== 'string' || item.url.length === 0) {
      const reason = item?.error?.message ? `：${item.error.message}` : ''
      throw new Error(`方舟没有返回图片地址${reason}`)
    }
    const format = textOf(item.output_format, extensionOf(item.url, '.jpeg').replace('.', ''))
    const ext = format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpeg'
    const saved = await saveFromUrl(item.url, input.dir, ext, input.prompt, input.signal)
    const dimensions = parseSize(item.size)
    return { model, size: item.size ?? size, ...dimensions, file: saved.file, bytes: saved.bytes }
  }

  async function createVideoTask(input) {
    const apiKey = await resolveApiKey()
    const model = textOf(input.model, settings.videoModel)
    const body = {
      model,
      content: [{ type: 'text', text: input.prompt }],
      watermark: false,
    }
    const resolution = textOf(input.resolution, '')
    if (resolution) body.resolution = resolution
    const ratio = textOf(input.ratio, '')
    if (ratio) body.ratio = ratio
    const duration = Number(input.duration)
    if (Number.isFinite(duration) && duration > 0) body.duration = Math.round(duration)
    const json = await arkRequest('/contents/generations/tasks', {
      method: 'POST',
      apiKey,
      body,
      signal: input.signal,
      timeoutMs: settings.requestTimeoutMs,
    })
    if (!json || typeof json.id !== 'string' || json.id.length === 0) {
      throw new Error('方舟没有返回视频任务 ID')
    }
    videoJobs.set(json.id, { prompt: input.prompt, sessionId: input.sessionId })
    return { taskId: json.id, model }
  }

  async function fetchVideoTask(taskId) {
    const apiKey = await resolveApiKey()
    return arkRequest(`/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      apiKey,
      timeoutMs: settings.requestTimeoutMs,
    })
  }

  /** 下载并落盘一个已成功的视频任务；同一任务只下载一次。 */
  async function settleVideoTask(taskId, dir) {
    const cached = videoResults.get(taskId)
    if (cached) return cached
    const task = await fetchVideoTask(taskId)
    if (task.status === 'succeeded') {
      const url = task?.content?.video_url
      if (typeof url !== 'string' || url.length === 0) throw new Error('视频任务已成功，但没有返回视频地址')
      const meta = videoJobs.get(taskId)
      const saved = await saveFromUrl(url, dir, 'mp4', meta?.prompt, undefined)
      const result = {
        taskId,
        status: 'succeeded',
        model: task.model,
        duration: task.duration,
        resolution: task.resolution,
        ratio: task.ratio,
        file: saved.file,
        bytes: saved.bytes,
      }
      videoResults.set(taskId, result)
      return result
    }
    return { taskId, status: task.status, model: task.model, error: task?.error?.message }
  }

  /** 轮询直到成功、失败或超时（Agent 工具使用）。 */
  async function waitVideoTask(taskId, dir, signal) {
    const deadline = Date.now() + settings.videoTimeoutMs
    for (;;) {
      if (signal?.aborted) throw new Error('已取消')
      const state = await settleVideoTask(taskId, dir)
      if (state.status === 'succeeded') return state
      if (state.status === 'failed' || state.status === 'expired' || state.status === 'cancelled') {
        throw new Error(`视频生成失败（${state.status}）${state.error ? `：${state.error}` : ''}`)
      }
      if (Date.now() > deadline) {
        throw new Error(
          `视频仍在生成（任务 ${taskId}），已等待 ${Math.round(settings.videoTimeoutMs / 1000)} 秒。可稍后在方舟控制台查看结果。`,
        )
      }
      await sleep(5000, signal)
    }
  }

  async function sessionDir(sessionId) {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const agents = ctx.get('agents')
      const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      if (agent) {
        try {
          return await ctx.workingDirectory.ensure(agent)
        } catch {
          /* 落到默认目录 */
        }
      }
    }
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory && typeof workingDirectory.defaultDirectory === 'string') {
      return workingDirectory.defaultDirectory
    }
    return process.cwd()
  }

  ctx.tools.register({
    name: 'doubao_image',
    description:
      '用豆包 Seedream 模型按文字提示词生成图片（火山方舟 API）。图片会保存到当前会话工作目录下的 doubao/ 目录，并返回绝对路径；生成通常需要 5–20 秒。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '图片描述。写清主体、动作、环境、风格与画面用途，中文不超过约 300 字。',
        },
        size: {
          type: 'string',
          description: '尺寸档位（1K / 1.5K / 2K / 4K）或具体像素（如 1024x1024）。默认沿用插件配置。',
        },
        model: {
          type: 'string',
          description: `模型 ID 或 Endpoint ID，默认 ${IMAGE_MODELS[0].id}（${IMAGE_MODELS[0].label}）。`,
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          path: { type: 'string' },
          absolutePath: { type: 'string' },
          model: { type: 'string' },
          size: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          elapsedMs: { type: 'integer' },
        },
        required: ['kind', 'path', 'absolutePath', 'model', 'elapsedMs'],
      },
      render(_args, value) {
        const dimensions = value.width && value.height ? `${value.width}×${value.height}` : value.size || '未知尺寸'
        return [
          {
            type: 'text',
            text: [
              `图片已生成：${value.absolutePath}`,
              `（工作目录相对路径 ${value.path}，${dimensions}，模型 ${value.model}，用时 ${(value.elapsedMs / 1000).toFixed(1)} 秒）`,
            ].join('\n'),
          },
        ]
      },
    },
    timeoutMs: settings.requestTimeoutMs + 30_000,
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('prompt 不能为空')
      if (!exec.agent) throw new Error('doubao_image 需要在一个会话中运行')
      const started = Date.now()
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const result = await generateImage({
        prompt,
        model: args?.model,
        size: args?.size,
        dir: outputDirFor(cwd),
        signal: exec.signal,
      })
      return {
        kind: 'image',
        path: relative(cwd, result.file) || result.file,
        absolutePath: result.file,
        model: result.model,
        size: result.size,
        ...(result.width ? { width: result.width } : {}),
        ...(result.height ? { height: result.height } : {}),
        bytes: result.bytes,
        elapsedMs: Date.now() - started,
      }
    },
  })

  ctx.tools.register({
    name: 'doubao_video',
    description:
      '用豆包 Seedance 模型按文字提示词生成短视频（火山方舟 API）。任务为异步：本工具会阻塞轮询直到完成，通常需要 1–3 分钟。视频保存到当前会话工作目录下的 doubao/ 目录并返回绝对路径。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '视频描述。写清画面内容、镜头运动、节奏与风格，中文不超过约 500 字。',
        },
        ratio: {
          type: 'string',
          description: '画面比例：16:9、9:16、1:1、4:3、3:4、21:9。默认沿用插件配置。',
        },
        duration: {
          type: 'integer',
          description: '时长（秒）。1.0 系列支持 2–12 秒，2.0 系列支持 4–15 秒，2.5 支持 4–30 秒，默认 5。',
        },
        resolution: {
          type: 'string',
          description: '分辨率：480p、720p、1080p。默认沿用插件配置。',
        },
        model: {
          type: 'string',
          description: `模型 ID 或 Endpoint ID，默认 ${VIDEO_MODELS[0].id}（${VIDEO_MODELS[0].label}）。`,
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          path: { type: 'string' },
          absolutePath: { type: 'string' },
          model: { type: 'string' },
          duration: { type: 'integer' },
          resolution: { type: 'string' },
          ratio: { type: 'string' },
          bytes: { type: 'integer' },
          elapsedMs: { type: 'integer' },
        },
        required: ['kind', 'path', 'absolutePath', 'elapsedMs'],
      },
      render(_args, value) {
        const details = [
          value.duration ? `${value.duration} 秒` : '',
          value.resolution || '',
          value.ratio || '',
          value.model || '',
        ]
          .filter(Boolean)
          .join('，')
        return [
          {
            type: 'text',
            text: [
              `视频已生成：${value.absolutePath}`,
              `（工作目录相对路径 ${value.path}${details ? `，${details}` : ''}，用时 ${(value.elapsedMs / 1000).toFixed(1)} 秒）`,
            ].join('\n'),
          },
        ]
      },
    },
    timeoutMs: settings.videoTimeoutMs + 60_000,
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('prompt 不能为空')
      if (!exec.agent) throw new Error('doubao_video 需要在一个会话中运行')
      const started = Date.now()
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const dir = outputDirFor(cwd)
      const created = await createVideoTask({
        prompt,
        model: args?.model,
        ratio: args?.ratio,
        duration: args?.duration,
        resolution: args?.resolution,
        signal: exec.signal,
      })
      const settled = await waitVideoTask(created.taskId, dir, exec.signal)
      return {
        kind: 'video',
        path: relative(cwd, settled.file) || settled.file,
        absolutePath: settled.file,
        ...(settled.model ? { model: settled.model } : {}),
        ...(settled.duration ? { duration: settled.duration } : {}),
        ...(settled.resolution ? { resolution: settled.resolution } : {}),
        ...(settled.ratio ? { ratio: settled.ratio } : {}),
        bytes: settled.bytes,
        elapsedMs: Date.now() - started,
      }
    },
  })

  // ---- Web 路由：只对本机页面开放，客户端从不接触 API Key ----

  function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function readJsonBody(req, limit = 1_048_576) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('请求体不是合法 JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  function guardOrigin(req) {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin.length === 0) return
    const allowed = new Set()
    try {
      allowed.add(ctx.webServer.getOrigin())
    } catch {
      /* 未绑定监听端口时忽略 */
    }
    if (allowed.has(origin)) return
    if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return
    throw new Error('只允许本机 Harness 页面调用该接口')
  }

  function serveMedia(req, res, id) {
    const entry = media.get(id)
    if (!entry) {
      sendJson(res, 404, { ok: false, error: '文件不存在或已过期，请重新生成' })
      return
    }
    stat(entry.path).then(
      (info) => {
        if (!info.isFile()) {
          media.delete(id)
          sendJson(res, 404, { ok: false, error: '文件已被移除' })
          return
        }
        const total = info.size
        const range = typeof req.headers.range === 'string' ? req.headers.range.match(/^bytes=(\d*)-(\d*)$/) : null
        if (range && (range[1].length > 0 || range[2].length > 0)) {
          let start = range[1].length > 0 ? Number(range[1]) : total - Number(range[2])
          let end = range[2].length > 0 ? Number(range[2]) : total - 1
          if (!Number.isFinite(start) || start < 0) start = 0
          if (!Number.isFinite(end) || end >= total) end = total - 1
          if (start > end) {
            res.writeHead(416, { 'content-range': `bytes */${total}` })
            res.end()
            return
          }
          res.writeHead(206, {
            'content-type': entry.mime,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${total}`,
            'accept-ranges': 'bytes',
            'cache-control': 'private, max-age=3600',
          })
          createReadStream(entry.path, { start, end }).pipe(res)
          return
        }
        res.writeHead(200, {
          'content-type': entry.mime,
          'content-length': String(total),
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=3600',
        })
        createReadStream(entry.path).pipe(res)
      },
      () => {
        media.delete(id)
        sendJson(res, 404, { ok: false, error: '文件已被移除' })
      },
    )
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname
    try {
      if (req.method === 'GET' && path === `${MEDIA_ROUTE}/state`) {
        const state = await keyState()
        sendJson(res, 200, {
          ok: true,
          ...state,
          keyRef: CREDENTIAL_REF,
          imageModel: settings.imageModel,
          videoModel: settings.videoModel,
          imageSize: settings.imageSize,
          imageModels: settings.imageModels,
          videoModels: settings.videoModels,
          outputDir: settings.outputDir,
          baseUrl: activeBase,
          entry: isPlanEntry(activeBase) ? 'plan' : 'ark',
        })
        return
      }

      if (req.method === 'POST' && path === `${MEDIA_ROUTE}/key`) {
        guardOrigin(req)
        const body = await readJsonBody(req)
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        if (body.clear === true) {
          const store = credentials()
          if (!store) throw new Error('当前环境没有凭据服务，请改用环境变量 ARK_API_KEY')
          await store.unset(CREDENTIAL_REF)
        } else {
          if (apiKey.length === 0) throw new Error('API Key 不能为空')
          const store = credentials()
          if (!store) throw new Error('当前环境没有凭据服务，请改用环境变量 ARK_API_KEY')
          await store.set(CREDENTIAL_REF, apiKey)
        }
        const state = await keyState()
        sendJson(res, 200, {
          ok: true,
          ...state,
          keyRef: CREDENTIAL_REF,
          imageModel: settings.imageModel,
          videoModel: settings.videoModel,
          imageSize: settings.imageSize,
          imageModels: settings.imageModels,
          videoModels: settings.videoModels,
          outputDir: settings.outputDir,
          baseUrl: activeBase,
          entry: isPlanEntry(activeBase) ? 'plan' : 'ark',
        })
        return
      }

      if (req.method === 'POST' && path === `${MEDIA_ROUTE}/generate`) {
        guardOrigin(req)
        const body = await readJsonBody(req)
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (prompt.length === 0) throw new Error('请先填写提示词')
        const kind = body.kind === 'video' ? 'video' : 'image'
        const base = await sessionDir(body.sessionId)
        const dir = outputDirFor(base)
        if (kind === 'video') {
          const created = await createVideoTask({
            prompt,
            model: body.model,
            ratio: body.ratio,
            duration: body.duration,
            resolution: body.resolution,
            sessionId: body.sessionId,
          })
          sendJson(res, 200, { ok: true, kind: 'video', taskId: created.taskId, model: created.model })
          return
        }
        const started = Date.now()
        const result = await generateImage({ prompt, model: body.model, size: body.size, dir })
        const shared = rememberMedia(result.file)
        sendJson(res, 200, {
          ok: true,
          kind: 'image',
          ...shared,
          path: relative(base, result.file) || result.file,
          absolutePath: result.file,
          model: result.model,
          size: result.size,
          ...(result.width ? { width: result.width } : {}),
          ...(result.height ? { height: result.height } : {}),
          bytes: result.bytes,
          elapsedMs: Date.now() - started,
        })
        return
      }

      if (req.method === 'GET' && path === `${MEDIA_ROUTE}/video`) {
        const taskId = url.searchParams.get('id')
        if (!taskId) throw new Error('缺少任务 ID')
        const base = await sessionDir(url.searchParams.get('session') || videoJobs.get(taskId)?.sessionId)
        const dir = outputDirFor(base)
        const settled = await settleVideoTask(taskId, dir)
        if (settled.status === 'succeeded') {
          const shared = rememberMedia(settled.file)
          sendJson(res, 200, {
            ok: true,
            kind: 'video',
            status: 'succeeded',
            ...shared,
            path: relative(base, settled.file) || settled.file,
            absolutePath: settled.file,
            model: settled.model,
            duration: settled.duration,
            resolution: settled.resolution,
            ratio: settled.ratio,
            bytes: settled.bytes,
          })
          return
        }
        if (settled.status === 'failed' || settled.status === 'expired') {
          sendJson(res, 200, { ok: true, status: settled.status, error: settled.error || '生成失败' })
          return
        }
        sendJson(res, 200, { ok: true, status: settled.status || 'queued' })
        return
      }

      if (req.method === 'GET' && path.startsWith(`${MEDIA_ROUTE}/media/`)) {
        serveMedia(req, res, path.slice(`${MEDIA_ROUTE}/media/`.length))
        return
      }

      sendJson(res, 404, { ok: false, error: '未知的豆包接口' })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: messageOf(error) })
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: MEDIA_ROUTE, handler: handle }),
      'doubao-media: same-origin routes',
    )
  })
}
