# 豆包创作 · DeepSeek Harness 插件

用[火山方舟](https://www.volcengine.com/product/ark)的豆包 **Seedream / Seedance** 在 DeepSeek Harness 里生成图片和短视频。

- **面板**：输入框下方新增「✦ 豆包创作」，选图片 / 视频、写提示词、生成，结果直接在面板里预览（视频可播放、可拖动），文件保存到当前会话工作目录的 `doubao/`。
- **设置页**：设置 → 豆包创作，提前填写 / 更换 / 清除火山方舟 API Key，并显示当前使用的接入入口。
- **Agent 工具**：注册 `doubao_image`、`doubao_video` 两个工具，模型可以在对话里直接调用（「帮我画一张…」「生成一段 5 秒的视频…」）。
- **双入口自适应**：按量付费（`/api/v3`）和 Agent Plan（`/api/plan/v3`）都支持，鉴权失败时自动切到另一个入口重试并记住，不用手改配置。

## 安装

需要 DeepSeek Harness Desktop（带 Web UI 的版本）。

1. 克隆到本地：

   ```bash
   git clone https://github.com/belikers/dsh-doubao-media.git
   ```

2. 在 DSH 里让 Agent 安装这个插件包（直接说「安装 `<克隆路径>` 这个插件」即可），它内部会执行 `plugin_manager install_bundle`，把包链进当前 profile 并启用。

3. **重启 DSH**。插件分两半：面板 UI 会热更新，但 Host 半（工具、路由、配置）在进程启动时加载，首次安装后必须重启一次。

4. 打开 **设置 → 豆包创作** 填入 API Key（见下）。

## 配置 API Key

在 **设置 → 豆包创作** 里粘贴火山方舟的 API Key 保存即可。密钥只写入本机凭据存储（`~/.dsh/.credentials.yaml`），不会进会话记录，浏览器也拿不到。

解析优先级（从高到低）：

1. 本机凭据存储（设置页保存的值）
2. 环境变量 `ARK_API_KEY` / `DOUBAO_API_KEY`
3. 插件配置 `apiKey`

Key 在[火山方舟控制台 → API Key 管理](https://ark.volcengine.com/region:cn-beijing/apiKey)创建，对应模型需要先开通。

### Agent Plan 套餐

如果你订阅的是 **Agent Plan**，必须使用套餐的**专属 API Key** 和**专属入口** `https://ark.cn-beijing.volces.com/api/plan/v3`——标准入口 `/api/v3` 会返回 `401 AuthenticationError`，反之亦然。

- 插件会在这两个入口之间自动回退：某个入口鉴权失败时换另一个重试一次，成功后固定使用，所以 `baseUrl` 填哪个都能跑通。
- 套餐能力按档位不同：**Small / Medium 只含图片生成**（`doubao-seedream-5.0-pro`、`doubao-seedream-5.0-flash`），**视频生成需要 Large / Max**；套餐不含的模型面板会提示 `UnsupportedModel`。
- 套餐入口同样接受带日期后缀的模型 ID（如 `doubao-seedream-5-0-pro-260628`）。

## 模型

| 类型 | 默认 | 面板可选 |
|---|---|---|
| 图片 | `doubao-seedream-5-0-pro-260628`（Seedream 5.0 Pro） | 5.0 Pro / 5.0 Flash / 5.0 Lite / 4.5（后两个标「即将下线」） |
| 视频 | `doubao-seedance-2-5-260628`（Seedance 2.5） | 2.5 / 2.0 / 2.0 Fast / 2.0 Mini / 1.0 Pro Fast / 1.0 Pro（后两个标「即将下线」） |

模型下拉里还有「自定义…」，可以直接填模型 ID 或推理接入点 **Endpoint ID**（`ep-…`）。账号未开通的模型会返回方舟的报错，面板会翻译成中文提示。

## Agent 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `doubao_image` | `prompt`（必填）、`size`、`model` | 同步接口，通常 5–20 秒；保存到 `<工作目录>/doubao/` 并返回路径 |
| `doubao_video` | `prompt`（必填）、`ratio`、`duration`、`resolution`、`model` | 异步任务，工具内阻塞轮询（通常 1–3 分钟）到完成或超时 |

两个工具都返回 `{ kind, path, absolutePath, model, elapsedMs, ... }`，Agent 拿到绝对路径后可以继续 `present` / `read`。

## 配置项

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖（`config` 整段替换，保留需要的字段）：

```yaml
- id: doubao-media
  name: dsh-doubao-media
  config:
    baseUrl: https://ark.cn-beijing.volces.com/api/v3   # Agent Plan 用 /api/plan/v3
    imageModel: doubao-seedream-5-0-pro-260628
    videoModel: doubao-seedance-2-5-260628
    imageSize: 2K             # 1K / 1.5K / 2K / 4K
    outputDir: ""             # 留空 = <会话工作目录>/doubao；相对路径按工作目录解析
    requestTimeoutMs: 180000  # 单次方舟请求超时
    videoTimeoutMs: 900000    # 视频任务轮询上限
    apiKey: ""                # 一般不填，推荐在设置页保存
```

## 工作原理与安全

- 浏览器只调用插件自己的同源路由 `/doubao-api/*`（`state` / `key` / `generate` / `video` / `media/<id>`），从不接触 API Key，也不直接访问方舟。
- 生成结果由 Host 下载落盘，再通过带随机 id 的媒体路由以 Range 方式提供预览；路由只接受本机来源，跨源写请求会被拒绝。
- 图片是同步接口；视频是异步任务，面板每 2 秒轮询一次，工具侧阻塞轮询到完成。
- 面板样式只用宿主主题 token（`--dsw-alias-*`），文案走 `ctx.locale`（中 / 英）。

## 开发

```bash
node test/host-smoke.mjs
```

`test/host-smoke.mjs` 用一个本地 stub 版方舟接口跑真实 HTTP，覆盖：两个工具、图片落盘、视频轮询到下载、`/state`、`/key`、`/generate`、`/video`、媒体路由的 Range（206）、空提示词、方舟报错透传、跨源拒绝，以及「入口自动回退」。用 DSH 自带的 Node（≥ 20）运行。

## 已知限制

- 只支持文生图 / 文生视频；暂不支持参考图、首尾帧、图生视频（Host 已预留模型 / Endpoint 参数，后续可扩展）。
- 图片生成是同步请求，2K / 4K 大图可能接近 1 分钟。
- 生成的 URL 由方舟返回，24 小时后失效；插件会立刻下载到本地，所以不受影响。

## License

[MIT](LICENSE) © 2026 belikers

---

**English**: A DeepSeek Harness plugin that adds a Doubao (Volcengine Ark) image/video generation panel under the composer, a settings page for the API key, and `doubao_image` / `doubao_video` agent tools. Works with both pay-as-you-go (`/api/v3`) and Agent Plan (`/api/plan/v3`) endpoints. Install the bundle into your DSH profile and restart the app once.
