/**
 * 豆包创作 · Client 半。
 *
 * 两个入口：
 * - 输入框下方的「豆包创作」面板（conversation.composer.dock）：选图片 / 视频、写提示词、预览结果；
 * - 设置里的「豆包创作」页（settings.section）：提前填写火山方舟 API Key。
 *
 * 所有网络请求都走 Host 半注册的同源路由 `/doubao-api/*`：浏览器从不接触 API Key，
 * 生成的文件由 Host 落盘后以 `/doubao-api/media/<id>` 提供预览（支持 Range）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-doubao-media',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const ROUTE = '/doubao-api'
    const SIZES = ['1K', '1.5K', '2K', '4K']
    const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
    const DURATIONS = [5, 10]
    const RESOLUTIONS = ['480p', '720p', '1080p']

    /** 中文是文案的基准，其余语言按 key 对齐。 */
    const zh = {
      label: '豆包创作',
      title: '豆包创作',
      image: '图片',
      video: '视频',
      close: '收起',
      promptPlaceholder: '描述你想生成的画面，例如：黄昏的草原上，一只金毛犬回头看向镜头，逆光，电影感',
      generate: '生成',
      generating: '生成中',
      submitting: '提交中',
      queued: '排队中',
      running: '生成中',
      size: '尺寸',
      model: '模型',
      customModel: '自定义…',
      customModelId: '模型 ID',
      modelPlaceholder: '模型或 Endpoint ID',
      hintKeyInvalid: 'API Key 无效或已失效：请在「设置 → 豆包创作」中更新后再试。',
      hintModelNotOpen: '该账号未开通这个模型：请到火山方舟控制台「开通管理」开通，或换一个模型 / 直接填 Endpoint ID。',
      hintUnsupported: '当前 Agent Plan 套餐不包含这个模型：Small、Medium 套餐不支持视频生成，可升级套餐或改用按量付费入口。',
      entryPlan: '接入入口：Agent Plan（/api/plan/v3）',
      entryArk: '接入入口：按量付费（/api/v3）',
      ratio: '比例',
      duration: '时长',
      resolution: '分辨率',
      seconds: '{n} 秒',
      elapsed: '已用 {s} 秒',
      videoHint: '视频通常需要 1–3 分钟，请保持页面打开。',
      videoTimeout: '视频仍在生成，可以稍后在方舟控制台查看结果。',
      emptyPrompt: '请先描述要生成的内容',
      failed: '生成失败',
      loading: '正在读取配置…',
      loadFailed: '读取配置失败',
      retry: '重试',
      settingsIntro:
        '用火山方舟的豆包 Seedream / Seedance 生成图片和视频。先在下面填写 API Key，之后在输入框下方的「豆包创作」面板里直接生成。',
      keyTitle: '火山方舟 API Key',
      keyHint:
        '在火山方舟控制台的「API Key 管理」创建后粘贴到这里。密钥只保存在本机凭据存储中，不会写入会话；也可以通过环境变量 ARK_API_KEY 提供。',
      keyPlaceholder: '粘贴 API Key，例如 ark-…',
      keyRequired: '请先填写 API Key',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      clear: '清除',
      clearOnlyFile: '当前 Key 来自环境变量或插件配置，需要修改对应来源才能更换。',
      notWritable: '当前环境没有可写的凭据存储，请改用环境变量 ARK_API_KEY。',
      configured: '已配置',
      notConfigured: '未配置',
      sourceFile: '本机凭据',
      sourceEnv: '环境变量',
      sourceConfig: '插件配置',
      setupTitle: '需要先在设置里填写 API Key',
      setupHint: '打开左下角「设置」→「豆包创作」，填入火山方舟 API Key，然后回到这里。',
      recheck: '重新检查',
      copyPath: '复制路径',
      copied: '已复制',
      took: '用时 {s} 秒',
    }

    const en = {
      label: 'Doubao Studio',
      title: 'Doubao Studio',
      image: 'Image',
      video: 'Video',
      close: 'Collapse',
      promptPlaceholder:
        'Describe the shot, e.g. a golden retriever turning toward the camera on a meadow at dusk, backlit, cinematic',
      generate: 'Generate',
      generating: 'Generating',
      submitting: 'Submitting',
      queued: 'Queued',
      running: 'Generating',
      size: 'Size',
      model: 'Model',
      customModel: 'Custom…',
      customModelId: 'Model ID',
      modelPlaceholder: 'Model or Endpoint ID',
      hintKeyInvalid: 'The API key is missing or invalid: update it in Settings → Doubao Studio.',
      hintModelNotOpen:
        'This model is not activated for the account: activate it in the Ark console, or pick another model / paste an Endpoint ID.',
      hintUnsupported:
        'The current Agent Plan tier does not include this model: Small and Medium plans have no video generation. Upgrade the plan or use the pay-as-you-go entry.',
      entryPlan: 'Entry: Agent Plan (/api/plan/v3)',
      entryArk: 'Entry: pay-as-you-go (/api/v3)',
      ratio: 'Ratio',
      duration: 'Length',
      resolution: 'Resolution',
      seconds: '{n}s',
      elapsed: '{s}s elapsed',
      videoHint: 'Video usually takes 1–3 minutes; keep this page open.',
      videoTimeout: 'The video is still generating; check the Ark console for the result.',
      emptyPrompt: 'Describe what to generate first',
      failed: 'Generation failed',
      loading: 'Reading configuration…',
      loadFailed: 'Could not read configuration',
      retry: 'Retry',
      settingsIntro:
        'Generate images and videos with Doubao Seedream and Seedance on Volcengine Ark. Save an API key here first, then use the Doubao Studio panel under the composer.',
      keyTitle: 'Volcengine Ark API key',
      keyHint:
        'Create a key under “API key management” in the Volcengine Ark console and paste it here. It is stored in this machine’s credential store and never written into a session; ARK_API_KEY also works.',
      keyPlaceholder: 'Paste the API key, e.g. ark-…',
      keyRequired: 'Enter an API key first',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      clear: 'Clear',
      clearOnlyFile: 'The key currently comes from the environment or plugin config; change it at that source.',
      notWritable: 'This deployment has no writable credential store; use the ARK_API_KEY environment variable.',
      configured: 'Configured',
      notConfigured: 'Not configured',
      sourceFile: 'local credential',
      sourceEnv: 'environment',
      sourceConfig: 'plugin config',
      setupTitle: 'Add an API key in Settings first',
      setupHint: 'Open Settings (bottom-left) → Doubao Studio, paste your Volcengine Ark API key, then come back here.',
      recheck: 'Check again',
      copyPath: 'Copy path',
      copied: 'Copied',
      took: 'took {s}s',
    }

    /** 同源 JSON 调用；`ok: false` 与 HTTP 错误都转成异常。 */
    async function call(path, init) {
      const response = await fetch(ROUTE + path, {
        credentials: 'include',
        cache: 'no-store',
        ...init,
        headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || (data && data.ok === false)) {
        throw new Error((data && data.error) || '请求失败（HTTP ' + response.status + '）')
      }
      return data
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /** 插件可独立渲染时的兜底翻译（locales 未就绪时退回中文）。 */
    function translateWith(translate) {
      return (key, params) => {
        if (typeof translate === 'function') return translate(key, params)
        const text = zh[key] !== undefined ? zh[key] : key
        if (!params) return text
        return String(text).replace(/\{(\w+)\}/g, (match, name) =>
          params[name] === undefined ? match : String(params[name]),
        )
      }
    }

    /** 配置里的默认模型不在目录里时，退到目录首项，避免默认选中一个不可用的 ID。 */
    function pickModel(models, preferred) {
      const list = Array.isArray(models) ? models.filter((entry) => entry && typeof entry.id === 'string') : []
      if (preferred && list.some((entry) => entry.id === preferred)) return preferred
      return list.length > 0 ? list[0].id : preferred || ''
    }

    /** 把方舟的账号级报错翻译成下一步动作。 */
    function errorHintOf(t, message) {
      const text = String(message || '')
      if (/HTTP 401|AuthenticationError|API key or AK\/SK/i.test(text)) return t('hintKeyInvalid')
      if (/UnsupportedModel|does not support the agent plan/i.test(text)) return t('hintUnsupported')
      if (/ModelNotOpen|not activated|InvalidEndpointOrModel|do not have access/i.test(text)) {
        return t('hintModelNotOpen')
      }
      return ''
    }

    function sourceLabelOf(t, source) {
      if (source === 'file') return t('sourceFile')
      if (source === 'env') return t('sourceEnv')
      if (source === 'config') return t('sourceConfig')
      return ''
    }

    function SparkIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M8 1.4c.85 3.5 2 4.65 5.5 5.5-3.5.85-4.65 2-5.5 5.5-.85-3.5-2-4.65-5.5-5.5C6 6.05 7.15 4.9 8 1.4Z',
          fill: 'currentColor',
        }),
      )
    }

    function CloseIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M4 4l8 8M12 4l-8 8',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          fill: 'none',
        }),
      )
    }

    const CSS =
      '.dbao-root{display:flex;flex-direction:column;align-items:flex-start;gap:6px;width:100%;box-sizing:border-box;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}' +
      '.dbao-trigger{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px 0 7px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}' +
      '.dbao-trigger:hover,.dbao-trigger:focus-visible{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}' +
      '.dbao-triggerOpen{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}' +
      '.dbao-card{box-sizing:border-box;width:100%;max-width:660px;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}' +
      '.dbao-head{display:flex;align-items:center;gap:8px}' +
      '.dbao-title{flex:1;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.dbao-seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}' +
      '.dbao-segBtn{padding:2px 10px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer}' +
      '.dbao-segBtnOn{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}' +
      '.dbao-close{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}' +
      '.dbao-close:hover,.dbao-close:focus-visible{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}' +
      '.dbao-form{display:flex;flex-direction:column;gap:8px}' +
      '.dbao-input{box-sizing:border-box;width:100%;min-height:58px;max-height:150px;resize:vertical;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:19px;outline:none}' +
      '.dbao-input:focus{border-color:var(--dsw-alias-brand-primary)}' +
      '.dbao-input::placeholder{color:var(--dsw-alias-label-secondary)}' +
      '.dbao-opts{display:flex;flex-wrap:wrap;align-items:center;gap:8px}' +
      '.dbao-fieldGroup{display:inline-flex;align-items:center;gap:4px;min-width:0}' +
      '.dbao-modelInput{box-sizing:border-box;width:150px;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;outline:none}' +
      '.dbao-modelInput:focus{border-color:var(--dsw-alias-brand-primary)}' +
      '.dbao-feedback{display:flex;flex-direction:column;gap:4px}' +
      '.dbao-field{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}' +
      '.dbao-select{height:24px;max-width:132px;padding:0 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}' +
      '.dbao-primary{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;margin-left:auto;padding:0 14px;border:0;border-radius:8px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:12px;font-weight:600;cursor:pointer}' +
      '.dbao-primary:disabled{opacity:.55;cursor:default}' +
      '.dbao-primaryInline{margin-left:0}' +
      '.dbao-status{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}' +
      '.dbao-elapsed{margin-left:auto;font-variant-numeric:tabular-nums}' +
      '.dbao-spin{width:11px;height:11px;flex:none;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dbao-spin .8s linear infinite}' +
      '@keyframes dbao-spin{to{transform:rotate(360deg)}}' +
      '.dbao-result{display:flex;flex-direction:column;gap:6px}' +
      '.dbao-media{display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}' +
      '.dbao-media img,.dbao-media video{display:block;width:100%;max-height:420px;object-fit:contain;background:var(--dsw-alias-bg-layer-2)}' +
      '.dbao-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}' +
      '.dbao-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}' +
      '.dbao-link{flex:none;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11px;cursor:pointer}' +
      '.dbao-error{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-word}' +
      '.dbao-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}' +
      '.dbao-setup{display:flex;flex-direction:column;align-items:flex-start;gap:8px}' +
      '.dbao-setupTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.dbao-section{display:flex;flex-direction:column;width:100%;max-width:720px;padding:4px 0 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}' +
      '.dbao-intro{padding:8px 0 16px}' +
      '.dbao-introTitle{font-size:16px;line-height:24px;font-weight:500}' +
      '.dbao-introDesc{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.dbao-setting{padding:16px 0;border-top:.5px solid var(--dsw-alias-border-l2)}' +
      '.dbao-settingTitle{font-size:14px;line-height:20px}' +
      '.dbao-settingDesc{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.dbao-keyRow{display:flex;align-items:center;gap:8px;margin-top:10px}' +
      '.dbao-settingsInput{box-sizing:border-box;flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}' +
      '.dbao-settingsInput:focus{border-color:var(--dsw-alias-brand-primary)}' +
      '.dbao-settingsInput::placeholder{color:var(--dsw-alias-label-secondary)}' +
      '.dbao-keyRow .dbao-primary{height:32px}' +
      '.dbao-btn{height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}' +
      '.dbao-btn:hover:not(:disabled),.dbao-btn:focus-visible:not(:disabled){color:var(--dsw-alias-label-primary)}' +
      '.dbao-btn:disabled{opacity:.5;cursor:default}' +
      '.dbao-stateLine{display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.dbao-stateLineOk{color:var(--dsw-alias-state-success-primary)}' +
      '.dbao-stateDot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}' +
      '.dbao-saved{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}'

    /**
     * 设置里的「豆包创作」页：提前填写火山方舟 API Key。
     * @param props - 插槽组合出的属性（locale 座位提供 `t`）。
     */
    function SettingsSection(props) {
      const t = useMemo(() => translateWith(props.t), [props.t])
      const [state, setState] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [error, setError] = useState(null)
      const [keyInput, setKeyInput] = useState('')
      const [saved, setSaved] = useState(false)
      const alive = useRef(true)

      useEffect(
        () => () => {
          alive.current = false
        },
        [],
      )

      const load = useCallback(async () => {
        try {
          const data = await call('/state')
          if (!alive.current) return
          setState(data)
          setPhase('ready')
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
          setPhase('ready')
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const save = useCallback(async () => {
        const value = keyInput.trim()
        if (value.length === 0) {
          setError(t('keyRequired'))
          return
        }
        setError(null)
        setSaved(false)
        setPhase('saving')
        try {
          const data = await call('/key', { method: 'POST', body: JSON.stringify({ apiKey: value }) })
          if (!alive.current) return
          setState(data)
          setKeyInput('')
          setSaved(true)
          setPhase('ready')
          setTimeout(() => {
            if (alive.current) setSaved(false)
          }, 2400)
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
          setPhase('ready')
        }
      }, [keyInput, t])

      const clear = useCallback(async () => {
        setError(null)
        setSaved(false)
        setPhase('clearing')
        try {
          const data = await call('/key', { method: 'POST', body: JSON.stringify({ clear: true }) })
          if (!alive.current) return
          setState(data)
          setPhase('ready')
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
          setPhase('ready')
        }
      }, [])

      const busy = phase === 'saving' || phase === 'clearing'
      const configured = Boolean(state && state.configured === true)
      const source = state && state.source
      const writable = !state || state.writable !== false

      return h(
        'div',
        { className: 'dbao-section' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dbao-intro' },
          h('div', { className: 'dbao-introTitle' }, t('title')),
          h('div', { className: 'dbao-introDesc' }, t('settingsIntro')),
        ),
        h(
          'div',
          { className: 'dbao-setting' },
          h('div', { className: 'dbao-settingTitle' }, t('keyTitle')),
          h('div', { className: 'dbao-settingDesc' }, t('keyHint')),
          h(
            'div',
            { className: 'dbao-keyRow' },
            h('input', {
              className: 'dbao-settingsInput',
              type: 'password',
              value: keyInput,
              placeholder: t('keyPlaceholder'),
              autoComplete: 'off',
              spellCheck: false,
              disabled: !writable || busy,
              'aria-label': t('keyTitle'),
              onChange: (event) => setKeyInput(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') save()
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dbao-primary dbao-primaryInline',
                disabled: !writable || busy || keyInput.trim().length === 0,
                onClick: save,
              },
              phase === 'saving' ? t('saving') : t('save'),
            ),
            source === 'file'
              ? h(
                  'button',
                  { type: 'button', className: 'dbao-btn', disabled: busy, onClick: clear },
                  t('clear'),
                )
              : null,
          ),
          h(
            'div',
            { className: 'dbao-stateLine' + (configured ? ' dbao-stateLineOk' : '') },
            h('span', { className: 'dbao-stateDot' }),
            configured
              ? t('configured') + (sourceLabelOf(t, source) ? ' · ' + sourceLabelOf(t, source) : '')
              : phase === 'loading'
                ? t('loading')
                : t('notConfigured'),
          ),
          state && state.entry
            ? h('div', { className: 'dbao-settingDesc' }, state.entry === 'plan' ? t('entryPlan') : t('entryArk'))
            : null,
          !writable ? h('div', { className: 'dbao-settingDesc' }, t('notWritable')) : null,
          writable && configured && source !== 'file'
            ? h('div', { className: 'dbao-settingDesc' }, t('clearOnlyFile'))
            : null,
          saved ? h('div', { className: 'dbao-saved', role: 'status' }, t('saved')) : null,
          error ? h('div', { className: 'dbao-error', role: 'alert' }, error) : null,
        ),
      )
    }

    /**
     * 输入框下方的「豆包创作」生成面板。
     * @param props - 插槽组合出的属性（`sessionId`、locale 座位提供的 `t`）。
     */
    function Widget(props) {
      const t = useMemo(() => translateWith(props.t), [props.t])
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined

      const [open, setOpen] = useState(false)
      const [kind, setKind] = useState('image')
      const [prompt, setPrompt] = useState('')
      const [hostState, setHostState] = useState(null)
      const [hostError, setHostError] = useState(null)
      const [phase, setPhase] = useState('idle')
      const [error, setError] = useState(null)
      const [result, setResult] = useState(null)
      const [elapsed, setElapsed] = useState(0)
      const [copied, setCopied] = useState(false)
      const [customModel, setCustomModel] = useState({ image: false, video: false })
      const [options, setOptions] = useState({
        size: '2K',
        imageModel: '',
        videoModel: '',
        ratio: '16:9',
        duration: 5,
        resolution: '720p',
      })

      const alive = useRef(true)
      const runToken = useRef(0)
      const startedAt = useRef(0)
      const promptRef = useRef(null)

      useEffect(
        () => () => {
          alive.current = false
          runToken.current += 1
        },
        [],
      )

      const busy = phase === 'submitting' || phase === 'queued' || phase === 'running'

      const refresh = useCallback(async () => {
        setHostError(null)
        try {
          const data = await call('/state')
          if (!alive.current) return
          setHostState(data)
          setOptions((previous) => ({
            ...previous,
            size: data.imageSize || previous.size,
            imageModel: previous.imageModel || pickModel(data.imageModels, data.imageModel),
            videoModel: previous.videoModel || pickModel(data.videoModels, data.videoModel),
          }))
        } catch (failure) {
          if (alive.current) setHostError(String((failure && failure.message) || failure))
        }
      }, [])

      useEffect(() => {
        if (open) refresh()
      }, [open, refresh])

      useEffect(() => {
        if (open && promptRef.current && typeof promptRef.current.focus === 'function') promptRef.current.focus()
      }, [open])

      useEffect(() => {
        if (!busy) return undefined
        const timer = setInterval(() => {
          setElapsed(Math.max(0, Math.round((Date.now() - startedAt.current) / 1000)))
        }, 500)
        return () => clearInterval(timer)
      }, [busy])

      const generate = useCallback(async () => {
        const text = prompt.trim()
        if (text.length === 0) {
          setError(t('emptyPrompt'))
          return
        }
        if (busy) return
        const token = runToken.current + 1
        runToken.current = token
        startedAt.current = Date.now()
        setError(null)
        setResult(null)
        setCopied(false)
        setElapsed(0)
        setPhase('submitting')
        const current = () => alive.current && runToken.current === token
        try {
          if (kind === 'image') {
            const data = await call('/generate', {
              method: 'POST',
              body: JSON.stringify({
                kind: 'image',
                prompt: text,
                model: String(options.imageModel || '').trim() || undefined,
                size: options.size,
                sessionId,
              }),
            })
            if (!current()) return
            setResult(data)
            setPhase('done')
            return
          }
          const created = await call('/generate', {
            method: 'POST',
            body: JSON.stringify({
              kind: 'video',
              prompt: text,
              model: String(options.videoModel || '').trim() || undefined,
              ratio: options.ratio,
              duration: options.duration,
              resolution: options.resolution,
              sessionId,
            }),
          })
          if (!current()) return
          setPhase('queued')
          const deadline = Date.now() + 20 * 60 * 1000
          for (;;) {
            await sleep(2000)
            if (!current()) return
            if (Date.now() > deadline) throw new Error(t('videoTimeout'))
            const data = await call(
              '/video?id=' + encodeURIComponent(created.taskId) + '&session=' + encodeURIComponent(sessionId || ''),
            )
            if (!current()) return
            if (data && (data.status === 'succeeded' || (data.url && data.absolutePath))) {
              setResult(data)
              setPhase('done')
              return
            }
            if (data && (data.status === 'failed' || data.status === 'expired')) {
              throw new Error(data.error || t('failed'))
            }
            setPhase(data && data.status === 'running' ? 'running' : 'queued')
          }
        } catch (failure) {
          if (!current()) return
          setError(String((failure && failure.message) || failure))
          setPhase('error')
        }
      }, [busy, kind, options, prompt, sessionId, t])

      const copyPath = useCallback(() => {
        const value = result && result.absolutePath
        if (!value || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return
        navigator.clipboard.writeText(value).then(
          () => {
            if (!alive.current) return
            setCopied(true)
            setTimeout(() => {
              if (alive.current) setCopied(false)
            }, 1600)
          },
          () => {},
        )
      }, [result])

      const switchKind = useCallback(
        (next) => {
          if (next === kind) return
          setKind(next)
          setResult(null)
          setError(null)
          setPhase('idle')
        },
        [kind],
      )

      const onPromptKeyDown = useCallback(
        (event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            generate()
          }
        },
        [generate],
      )

      function selectField(labelKey, values, selected, onSelect) {
        return h(
          'label',
          { className: 'dbao-field' },
          t(labelKey),
          h(
            'select',
            {
              className: 'dbao-select',
              value: selected,
              disabled: busy,
              onChange: (event) => onSelect(event.target.value),
            },
            values.map((value) =>
              h('option', { key: String(value), value: String(value) }, optionLabel(labelKey, value)),
            ),
          ),
        )
      }

      function optionLabel(labelKey, value) {
        if (labelKey === 'duration') return t('seconds', { n: value })
        return String(value)
      }

      function modelField(labelKey, models, selected, onSelect, isCustom, onToggleCustom) {
        const list = Array.isArray(models) ? models.filter((entry) => entry && typeof entry.id === 'string') : []
        return h(
          'label',
          { className: 'dbao-field' },
          t(labelKey),
          h(
            'select',
            {
              className: 'dbao-select',
              value: isCustom ? '__custom__' : selected,
              disabled: busy,
              onChange: (event) => {
                const value = event.target.value
                if (value === '__custom__') {
                  onToggleCustom(true)
                  onSelect('')
                  return
                }
                onToggleCustom(false)
                onSelect(value)
              },
            },
            list.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label || entry.id)),
            h('option', { value: '__custom__' }, t('customModel')),
          ),
        )
      }

      /** 模型控件：目录下拉 + 自定义模型 / Endpoint ID 输入。 */
      function modelControl(kindKey) {
        const image = kindKey === 'image'
        const models = image ? hostState && hostState.imageModels : hostState && hostState.videoModels
        const selected = image ? options.imageModel : options.videoModel
        const fallback = image ? hostState && hostState.imageModel : hostState && hostState.videoModel
        const isCustom = customModel[kindKey] === true
        const onSelect = (value) =>
          setOptions((previous) => ({ ...previous, [image ? 'imageModel' : 'videoModel']: value }))
        return h(
          'span',
          { className: 'dbao-fieldGroup' },
          modelField('model', models, selected, onSelect, isCustom, (next) =>
            setCustomModel((previous) => ({ ...previous, [kindKey]: next })),
          ),
          isCustom
            ? h('input', {
                className: 'dbao-modelInput',
                value: selected,
                placeholder: fallback || t('modelPlaceholder'),
                'aria-label': t('customModelId'),
                spellCheck: false,
                autoComplete: 'off',
                disabled: busy,
                onChange: (event) => onSelect(event.target.value),
              })
            : null,
        )
      }

      function statusText() {
        if (phase === 'submitting') return t('submitting')
        if (phase === 'queued') return t('queued')
        if (phase === 'running') return t('running')
        return t('generating')
      }

      function describeResult(value) {
        if (!value) return ''
        if (value.kind === 'video') {
          const parts = []
          if (value.duration) parts.push(t('seconds', { n: value.duration }))
          if (value.resolution) parts.push(value.resolution)
          if (value.model) parts.push(value.model)
          return parts.join(' · ')
        }
        const parts = []
        if (value.width && value.height) parts.push(value.width + '×' + value.height)
        else if (value.size) parts.push(value.size)
        if (value.model) parts.push(value.model)
        if (typeof value.elapsedMs === 'number') parts.push(t('took', { s: (value.elapsedMs / 1000).toFixed(1) }))
        return parts.join(' · ')
      }

      const currentModel = String((kind === 'image' ? options.imageModel : options.videoModel) || '').trim()
      const modelMissing = customModel[kind] === true && currentModel.length === 0

      const form = h(
        'div',
        { className: 'dbao-form' },
        h('textarea', {
          className: 'dbao-input',
          ref: promptRef,
          'aria-label': t('title'),
          rows: 2,
          value: prompt,
          placeholder: t('promptPlaceholder'),
          disabled: busy,
          onChange: (event) => setPrompt(event.target.value),
          onKeyDown: onPromptKeyDown,
        }),
        h(
          'div',
          { className: 'dbao-opts' },
          kind === 'image'
            ? selectField('size', SIZES, options.size, (value) => setOptions((previous) => ({ ...previous, size: value })))
            : selectField('ratio', RATIOS, options.ratio, (value) =>
                setOptions((previous) => ({ ...previous, ratio: value })),
              ),
          kind === 'image' ? modelControl('image') : modelControl('video'),
          kind === 'video'
            ? selectField('duration', DURATIONS, options.duration, (value) =>
                setOptions((previous) => ({ ...previous, duration: Number(value) })),
              )
            : null,
          kind === 'video'
            ? selectField('resolution', RESOLUTIONS, options.resolution, (value) =>
                setOptions((previous) => ({ ...previous, resolution: value })),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dbao-primary',
              disabled: busy || prompt.trim().length === 0 || modelMissing,
              onClick: generate,
            },
            busy ? h('span', { className: 'dbao-spin' }) : null,
            busy ? t('generating') : t('generate'),
          ),
        ),
        busy
          ? h(
              'div',
              { className: 'dbao-status' },
              h('span', null, statusText()),
              h('span', { className: 'dbao-elapsed' }, t('elapsed', { s: elapsed })),
            )
          : null,
        !busy && kind === 'video' && !result ? h('div', { className: 'dbao-hint' }, t('videoHint')) : null,
        error && phase === 'error'
          ? h(
              'div',
              { className: 'dbao-feedback' },
              h('div', { className: 'dbao-error', role: 'alert' }, error),
              errorHintOf(t, error) ? h('div', { className: 'dbao-hint' }, errorHintOf(t, error)) : null,
            )
          : null,
        result
          ? h(
              'div',
              { className: 'dbao-result' },
              h(
                'div',
                { className: 'dbao-media' },
                result.kind === 'video'
                  ? h('video', { src: result.url, controls: true, playsInline: true, preload: 'metadata' })
                  : h('img', { src: result.url, alt: 'doubao' }),
              ),
              h(
                'div',
                { className: 'dbao-meta' },
                h('span', { className: 'dbao-path', title: result.absolutePath }, result.path || result.absolutePath),
                h('span', null, describeResult(result)),
                h(
                  'button',
                  { type: 'button', className: 'dbao-link', onClick: copyPath },
                  copied ? t('copied') : t('copyPath'),
                ),
              ),
            )
          : null,
      )

      const setup = h(
        'div',
        { className: 'dbao-setup' },
        h('div', { className: 'dbao-setupTitle' }, t('setupTitle')),
        h('div', { className: 'dbao-hint' }, t('setupHint')),
        hostState && hostState.writable === false ? h('div', { className: 'dbao-hint' }, t('notWritable')) : null,
        hostError ? h('div', { className: 'dbao-error', role: 'alert' }, hostError) : null,
        h(
          'button',
          { type: 'button', className: 'dbao-primary dbao-primaryInline', onClick: refresh },
          t('recheck'),
        ),
      )

      let body
      if (hostError && !hostState) {
        body = h(
          'div',
          { className: 'dbao-setup' },
          h('div', { className: 'dbao-error', role: 'alert' }, t('loadFailed') + '：' + hostError),
          h(
            'button',
            { type: 'button', className: 'dbao-primary dbao-primaryInline', onClick: refresh },
            t('retry'),
          ),
        )
      } else if (!hostState) {
        body = h('div', { className: 'dbao-hint' }, t('loading'))
      } else if (hostState.configured !== true) {
        body = setup
      } else {
        body = form
      }

      return h(
        'div',
        { className: 'dbao-root' },
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'dbao-trigger' + (open ? ' dbao-triggerOpen' : ''),
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          h(SparkIcon, null),
          h('span', null, t('label')),
        ),
        open
          ? h(
              'section',
              { className: 'dbao-card', 'aria-label': t('title') },
              h(
                'div',
                { className: 'dbao-head' },
                h('span', { className: 'dbao-title' }, t('title')),
                h(
                  'div',
                  { className: 'dbao-seg', role: 'group' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dbao-segBtn' + (kind === 'image' ? ' dbao-segBtnOn' : ''),
                      'aria-pressed': kind === 'image',
                      disabled: busy,
                      onClick: () => switchKind('image'),
                    },
                    t('image'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dbao-segBtn' + (kind === 'video' ? ' dbao-segBtnOn' : ''),
                      'aria-pressed': kind === 'video',
                      disabled: busy,
                      onClick: () => switchKind('video'),
                    },
                    t('video'),
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dbao-close',
                    'aria-label': t('close'),
                    onClick: () => setOpen(false),
                  },
                  h(CloseIcon, null),
                ),
              ),
              body,
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register('doubao', { zh, en }),
          'doubao-media: dictionaries',
        )
        const translate = ctx.locale.bind('doubao')

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'doubao-media',
              order: 20,
              label: () => translate('label'),
              locale: 'doubao',
              inject: () => ({ t: translate }),
            },
            Widget,
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'doubao-media',
              order: 22,
              label: () => translate('title'),
              locale: 'doubao',
              inject: () => ({ t: translate }),
            },
            SettingsSection,
          ),
        )
      },
    }
  },
})
