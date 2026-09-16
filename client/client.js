/**
 * 浏览器半边：设置页里的「技能」分区。
 *
 * 只依赖 `react`，自带样式表。这不只是省事：DSH 的客户端模块表里**没有**
 * `@deepseek-ai/dsh-client-ui-primitives` 这个包，而参考实现却在 require 它 ——
 * 依赖一个可能不存在的模块会把整块 UI 变成一次赌博。用原生元素加一份自带 CSS，
 * 在任何 DSH 版本上都能渲染出来，最多是样子朴素一点。
 *
 * 界面的诚实准则：每一行显示的是**注册表的真实裁决**（谁赢了、最终策略是什么），
 * 而不是我们往 state.json 写了什么。被同名技能遮蔽的行会明说「你的启停不生效」，
 * 损坏的行会把诊断一并摊开 —— 这个面板存在的意义就是回答「为什么它没生效」。
 *
 * 形态是客户端模块系统的手写懒 CJS 工厂：不需要打包器，因为没有要打包的东西。
 */

window.__ModuleLoader__.load({
  id: '@lolkda/dsh-skills-manager',
  factory: (require) => {
    const React = require('react')

    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 宿主路由前缀，必须与 lib/routes.js 的 ROUTE_PREFIX 一致。 */
    const ROUTE = '/dsh-skills-manager'

    /** 设置导航里的位置：排在提示词之后。 */
    const SECTION_ORDER = 62

    /** 样式表标识，用于避免重复注入与卸载时清理。 */
    const STYLE_ID = 'dsh-skills-manager'

    /**
     * 打一次宿主接口。
     * @param {string} path - 端点路径
     * @param {object} [body] - POST 请求体
     * @returns {Promise<object>} 响应体
     */
    /**
     * 本次面板使用的项目目录。
     *
     * 服务端在没有 `cwd` 时会退化成"取某个会话的 cwd"—— 那个会话可能是任意一个，顺序也不
     * 保证稳定。于是同一个面板的两次请求完全可能落到不同项目上，而项目级技能根
     * （`<项目>/.dsh/skills`、`<项目>/.agents/skills`）会跟着换一套，用户却看不出任何异常。
     * 所以第一次拿到服务端解析出的值就把它**钉住**，此后每次请求都显式带回。
     * @type {string|null}
     */
    let pinnedCwd = null

    async function request(path, body) {
      const query = pinnedCwd ? `${path.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(pinnedCwd)}` : ''
      const response = await fetch(`${ROUTE}${path}${query}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null)
      if (!payload) throw new Error(`接口返回了非 JSON 响应（HTTP ${response.status}）`)
      return payload
    }

    /**
     * 把文件读成 base64（去掉 data URL 前缀）。
     * @param {File} file - 浏览器文件对象
     * @returns {Promise<string>} base64
     */
    function readBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result ?? '')
          resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
        }
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }

    /** 一个小开关。 */
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          className: `dshsm-switch${props.checked ? ' dshsm-switch--on' : ''}`,
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          disabled: props.disabled === true,
          title: props.title,
          onClick: () => props.onChange(!props.checked),
        },
        h('span', { className: 'dshsm-switch__knob' }),
      )
    }

    /** 状态标签。 */
    function Pill(props) {
      return h('span', { className: `dshsm-pill dshsm-pill--${props.tone}` }, props.children)
    }

    /**
     * 一行技能。
     * @param {object} props - 技能记录与回调
     * @returns {object} 元素
     */
    function SkillRow(props) {
      const skill = props.skill
      const overridden = skill.override === true || skill.override === false
      const disabled = !skill.winner || !skill.loadable
      return h(
        'div',
        { className: `dshsm-row${props.selected ? ' dshsm-row--selected' : ''}${skill.winner ? '' : ' dshsm-row--shadowed'}` },
        h(
          'div',
          { className: 'dshsm-row__main', onClick: props.onSelect, role: 'button', tabIndex: 0 },
          h(
            'div',
            { className: 'dshsm-row__title' },
            h('code', { className: 'dshsm-name' }, skill.name),
            h(Pill, { tone: skill.winner ? 'source' : 'muted' }, skill.source),
            skill.shadowed ? h(Pill, { tone: 'muted' }, `被 ${skill.source} 遮蔽`) : null,
            !skill.loadable ? h(Pill, { tone: 'danger' }, '不可加载') : null,
            overridden ? h(Pill, { tone: 'warn' }, skill.override ? '手动启用' : '手动停用') : null,
            skill.overrideShadowed ? h(Pill, { tone: 'danger' }, '启停未生效') : null,
          ),
          h('div', { className: 'dshsm-row__desc' }, skill.description || h('em', null, '（没有 description）')),
          h(
            'div',
            { className: 'dshsm-row__meta' },
            h('span', { title: skill.docPath }, skill.docPath),
            skill.kind === 'flat' ? ' · 平铺文件' : '',
            skill.rank !== undefined ? ` · rank ${skill.rank}` : '',
          ),
        ),
        h(
          'div',
          { className: 'dshsm-row__action' },
          h(Switch, {
            checked: skill.enabled,
            disabled,
            label: `${skill.enabled ? '停用' : '启用'} ${skill.name}`,
            title: disabled
              ? '这条不是实际生效的技能，或不具备合法调用策略'
              : overridden
                ? '当前为手动启停（不改源文件）'
                : '当前沿用文件自身的策略',
            onChange: (next) => props.onToggle(skill, next),
          }),
        ),
      )
    }

    /** 技能详情面板。 */
    function Detail(props) {
      const skill = props.skill
      // 没有回收站了，删除就是永久删除 —— 点一下直接删掉别人的文件是不可接受的，
      // 所以必须先确认。就地二段式，不用 window.confirm：那个会阻塞宿主线程，
      // 也没法在渲染测试里断言。
      const [confirming, setConfirming] = useState(false)
      const overridden = skill.override === true || skill.override === false
      return h(
        'div',
        { className: 'dshsm-detail' },
        h(
          'dl',
          { className: 'dshsm-kv' },
          h('dt', null, '文件'),
          h('dd', null, h('code', null, skill.docPath)),
          h('dt', null, '来源'),
          h('dd', null, `${skill.source}（rank ${skill.rank}${skill.scope === 'project' ? '，项目级' : ''}）`),
          h('dt', null, '文件自身策略'),
          h('dd', null, `模型 ${skill.fileModelInvocable ? '可用' : '不可用'} · 用户 ${skill.fileUserInvocable ? '可用' : '不可用'}`),
          h('dt', null, '当前生效策略'),
          h(
            'dd',
            null,
            `模型 ${skill.effectiveModelInvocable ? '可用' : '不可用'} · 用户 ${skill.effectiveUserInvocable ? '可用' : '不可用'}`,
            overridden ? h('span', { className: 'dshsm-hint' }, '（来自手动启停覆盖，源文件未改动）') : null,
          ),
        ),
        props.siblings.length > 1
          ? h(
              'div',
              { className: 'dshsm-notice dshsm-notice--warn' },
              `同名技能存在于 ${props.siblings.length} 处；实际生效的是 rank 最小的那条，其余为遮蔽项：`,
              h(
                'ul',
                { className: 'dshsm-list' },
                props.siblings.map((item) =>
                  h('li', { key: item.docPath }, `${item.source} · ${item.docPath}${item.winner ? '（生效）' : '（遮蔽）'}`),
                ),
              ),
            )
          : null,
        skill.invocationPolicyValid === false
          ? h('div', { className: 'dshsm-notice dshsm-notice--danger' }, '调用策略写法非法，注册表会整条丢弃它。请修正 frontmatter 里的布尔值。')
          : null,
        skill.diagnostics && skill.diagnostics.length > 0
          ? h(
              'div',
              { className: 'dshsm-notice dshsm-notice--danger' },
              '诊断：',
              h(
                'ul',
                { className: 'dshsm-list' },
                skill.diagnostics.map((item, index) => h('li', { key: index }, item.message)),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dshsm-actions' },
          h('button', { type: 'button', className: 'dshsm-btn', onClick: props.onEdit, disabled: !skill.mutable }, '✎ 编辑正文'),
          overridden
            ? h('button', { type: 'button', className: 'dshsm-btn', onClick: () => props.onToggle(skill, null) }, '↺ 恢复文件设定')
            : null,
          confirming
            ? h(
                'span',
                { className: 'dshsm-confirm' },
                h('span', { className: 'dshsm-confirm__text' }, `永久删除 ${skill.name}？不可撤销。`),
                h('button', { type: 'button', className: 'dshsm-btn dshsm-btn--danger', onClick: props.onDelete }, '确认删除'),
                h('button', { type: 'button', className: 'dshsm-btn', onClick: () => setConfirming(false) }, '取消'),
              )
            : h(
                'button',
                { type: 'button', className: 'dshsm-btn dshsm-btn--danger', onClick: () => setConfirming(true), disabled: !skill.mutable },
                '✕ 删除',
              ),
        ),
      )
    }

    /** 正文编辑器。 */
    function Editor(props) {
      const [text, setText] = useState(props.content)
      const [busy, setBusy] = useState(false)
      const [problems, setProblems] = useState([])
      useEffect(() => {
        setText(props.content)
        setProblems([])
      }, [props.content, props.docPath])

      /**
       * 保存。
       * @returns {Promise<void>} 完成
       */
      const save = async () => {
        setBusy(true)
        setProblems([])
        const response = await request('/skill/save', { rootKey: props.rootKey, name: props.name, content: text }).catch((error) => ({
          ok: false,
          error: String(error && error.message ? error.message : error),
        }))
        setBusy(false)
        if (response.ok) return props.onSaved()
        setProblems(response.diagnostics ? response.diagnostics.map((item) => item.message) : [response.error])
      }

      return h(
        'div',
        { className: 'dshsm-editor' },
        h('div', { className: 'dshsm-editor__head' }, h('code', null, props.docPath)),
        h('textarea', {
          className: 'dshsm-textarea',
          value: text,
          spellCheck: false,
          onChange: (event) => setText(event.target.value),
        }),
        problems.length > 0
          ? h(
              'div',
              { className: 'dshsm-notice dshsm-notice--danger' },
              '保存被拒绝（这会让技能变成注册表无法加载的样子）：',
              h(
                'ul',
                { className: 'dshsm-list' },
                problems.map((message, index) => h('li', { key: index }, message)),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dshsm-actions' },
          h('button', { type: 'button', className: 'dshsm-btn dshsm-btn--primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          h('button', { type: 'button', className: 'dshsm-btn', onClick: props.onCancel, disabled: busy }, '取消'),
        ),
        h('p', { className: 'dshsm-hint' }, '保存是整份替换；被拒绝时磁盘上的文件一个字节都不会变。'),
      )
    }

    /** 新建技能表单。 */
    function CreateForm(props) {
      const [fields, setFields] = useState({ name: '', description: '', whenToUse: '', body: '' })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const set = (key) => (event) => setFields({ ...fields, [key]: event.target.value })

      /**
       * 提交。
       * @returns {Promise<void>} 完成
       */
      const submit = async () => {
        setBusy(true)
        setError(null)
        const response = await request('/skill/create', { rootKey: props.rootKey, ...fields }).catch((err) => ({ ok: false, error: String(err) }))
        setBusy(false)
        if (response.ok) return props.onDone()
        setError(response.error ?? '创建失败')
      }

      return h(
        'div',
        { className: 'dshsm-form' },
        h('h4', null, '新建技能'),
        h('label', { className: 'dshsm-field' }, h('span', null, '名字'), h('input', { value: fields.name, onChange: set('name'), placeholder: 'my-skill' })),
        h('label', { className: 'dshsm-field' }, h('span', null, '描述（必填）'), h('input', { value: fields.description, onChange: set('description') })),
        h('label', { className: 'dshsm-field' }, h('span', null, '何时使用（可选）'), h('input', { value: fields.whenToUse, onChange: set('whenToUse') })),
        h('label', { className: 'dshsm-field dshsm-field--wide' }, h('span', null, '正文'), h('textarea', { className: 'dshsm-textarea dshsm-textarea--short', value: fields.body, onChange: set('body') })),
        error ? h('div', { className: 'dshsm-notice dshsm-notice--danger' }, error) : null,
        h(
          'div',
          { className: 'dshsm-actions' },
          h('button', { type: 'button', className: 'dshsm-btn dshsm-btn--primary', onClick: submit, disabled: busy }, busy ? '创建中…' : '创建'),
          h('button', { type: 'button', className: 'dshsm-btn', onClick: props.onCancel, disabled: busy }, '取消'),
        ),
        h('p', { className: 'dshsm-hint' }, `将写入 ${props.rootPath}`),
      )
    }

    /** 导入技能面板。 */
    function ImportForm(props) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [path, setPath] = useState('')
      const [overwrite, setOverwrite] = useState(false)

      /**
       * 上传一个文件（ZIP 或单个 Markdown）。
       * @param {Event} event - 文件选择事件
       * @returns {Promise<void>} 完成
       */
      const upload = async (event) => {
        const file = event.target.files && event.target.files[0]
        if (!file) return
        setBusy(true)
        setError(null)
        const isZip = /\.zip$/i.test(file.name)
        const payload = isZip
          ? { kind: 'zip', base64: await readBase64(file), overwrite }
          : { kind: 'markdown', fileName: file.name, content: await file.text(), overwrite }
        const response = await request('/skill/import', { rootKey: props.rootKey, ...payload }).catch((err) => ({ ok: false, error: String(err) }))
        setBusy(false)
        event.target.value = ''
        if (response.ok) return props.onDone()
        setError(response.diagnostics ? response.diagnostics.map((d) => d.message).join('；') : (response.error ?? '导入失败'))
      }

      /**
       * 从服务端本地目录导入。
       * @returns {Promise<void>} 完成
       */
      const importPath = async () => {
        setBusy(true)
        setError(null)
        const response = await request('/skill/import', { rootKey: props.rootKey, kind: 'path', path, overwrite }).catch((err) => ({ ok: false, error: String(err) }))
        setBusy(false)
        if (response.ok) return props.onDone()
        setError(response.error ?? '导入失败')
      }

      return h(
        'div',
        { className: 'dshsm-form' },
        h('h4', null, '导入技能'),
        h('label', { className: 'dshsm-field' }, h('span', null, 'ZIP 或单个 SKILL.md'), h('input', { type: 'file', accept: '.zip,.md', onChange: upload, disabled: busy })),
        h('label', { className: 'dshsm-field' }, h('span', null, '或本机目录 / 文件路径'), h('input', { value: path, onChange: (e) => setPath(e.target.value), placeholder: 'F:\\skills\\my-skill' })),
        h('label', { className: 'dshsm-check' }, h('input', { type: 'checkbox', checked: overwrite, onChange: (e) => setOverwrite(e.target.checked) }), '同名技能存在时覆盖'),
        error ? h('div', { className: 'dshsm-notice dshsm-notice--danger' }, error) : null,
        h(
          'div',
          { className: 'dshsm-actions' },
          h('button', { type: 'button', className: 'dshsm-btn', onClick: importPath, disabled: busy || !path.trim() }, busy ? '导入中…' : '从路径导入'),
          h('button', { type: 'button', className: 'dshsm-btn', onClick: props.onCancel, disabled: busy }, '取消'),
        ),
        h('p', { className: 'dshsm-hint' }, '导入结果统一为 <root>/<name>/SKILL.md 的目录 bundle，附属文件原样保留。'),
      )
    }

    // 两个图标的 path 逐字取自 DSH 自己的选择器（`dsh-client-locale` 的 LanguageRow 与
    // shell 的 Menu），照抄是为了让形状完全一致 —— 手画一个"差不多的"箭头骗不过眼睛。
    const CHEVRON_PATH =
      'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'
    const CHECK_PATH =
      'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z'

    /**
     * 自绘下拉。
     *
     * **不用原生 `<select>`** —— 它的外观和弹出的那一层都是操作系统画的（Windows 上是
     * 深蓝高亮），完全脱离 DSH 的设计语言，改 CSS 也管不到弹层。DSH 自己的选择器是
     * 「pill 按钮 + chevron + 独立菜单层」，这里照它的几何与令牌实现一份。
     * @param {object} props - `value` / `options` / `onChange`
     * @returns {object} 元素
     */
    function ScopeSelect(props) {
      const [open, setOpen] = useState(false)
      const boxRef = useRef(null)

      // 点外面关掉。用 document 上的监听而不是触发按钮的 onBlur —— 菜单里那一项被按下时
      // 焦点会先离开触发按钮，用 blur 会在选择生效之前就把菜单收掉。
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const current = props.value
      return h(
        'div',
        { className: 'dshsm-select', ref: boxRef },
        h(
          'button',
          {
            type: 'button',
            className: 'dshsm-select__trigger',
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            title: current,
            onClick: () => setOpen(!open),
          },
          h('span', { className: 'dshsm-select__value' }, current),
          h(
            'svg',
            { className: 'dshsm-select__chevron', width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none' },
            h('path', { d: CHEVRON_PATH, fill: 'currentColor' }),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'dshsm-menu', role: 'menu' },
              props.options.map((item) =>
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    key: item,
                    className: `dshsm-menu__item${item === current ? ' dshsm-menu__item--on' : ''}`,
                    title: item,
                    onClick: () => {
                      setOpen(false)
                      props.onChange(item)
                    },
                  },
                  h('span', { className: 'dshsm-menu__label' }, item),
                  item === current
                    ? h(
                        'svg',
                        { className: 'dshsm-menu__check', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' },
                        h('path', { d: CHECK_PATH, fill: 'currentColor' }),
                      )
                    : null,
                ),
              ),
            )
          : null,
      )
    }

    /** 主分区。 */
    /**
     * 把注册表核对结果渲染成一条提示。
     *
     * 一致的结论也要显示：那是一句**经过实测**的话，而不是插件的自称 —— 这个面板最容易犯的
     * 错就是"说技能在生效，而模型根本没收到"。
     * @param {object|null} divergence - `/registry` 返回的核对结果
     * @returns {object|null} 节点
     */
    function divergenceNotice(divergence) {
      if (!divergence || !divergence.checked) return null
      const missing = divergence.missing ?? []
      const extra = divergence.extra ?? []
      if (missing.length === 0 && extra.length === 0) {
        return h('div', { className: 'dshsm-notice dshsm-notice--ok' }, `已与 DSH 实际解析核对：${divergence.ours} 条一致`)
      }
      const parts = []
      if (missing.length > 0) parts.push(`本插件多报了 ${missing.length} 条（DSH 里没有，模型收不到）：${missing.join('、')}`)
      if (extra.length > 0) parts.push(`本插件少报了 ${extra.length} 条（DSH 里有，界面看不到）：${extra.join('、')}`)
      return h('div', { className: 'dshsm-notice dshsm-notice--danger' }, parts.join('；'))
    }

    function SkillsSection() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [filter, setFilter] = useState('all')
      const [selected, setSelected] = useState(null)
      const [mode, setMode] = useState(null)
      const [editor, setEditor] = useState(null)
      const [cwd, setCwd] = useState(null)
      const [registry, setRegistry] = useState(null)

      /**
       * 重新拉取目录。
       * @returns {Promise<void>} 完成
       */
      const reload = useCallback(async () => {
        try {
          // 同时拉注册表：本插件与 dsh-skill-filesystem 各有一份配置，两边没有任何机制保证
          // 一致。多报会让用户以为技能在生效、少报会让技能隐形，两种都不报错 —— 只能主动比。
          const [response, registry] = await Promise.all([
            request('/catalog'),
            request('/registry').catch(() => null),
          ])
          setRegistry(registry && registry.ok ? registry.data : null)
          if (!response.ok) {
            setError(response.error ?? '读取目录失败')
            return
          }
          setData(response.data)
          // 钉住服务端实际用来解析项目根的那个目录，之后的请求一律显式带回。
          if (pinnedCwd === null && response.data.cwd) pinnedCwd = response.data.cwd
          setCwd(pinnedCwd)
          setError(null)
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        }
      }, [])

      useEffect(() => {
        reload()
      }, [reload])

      /**
       * 换一个项目目录，重新解析所有根目录。
       * @param {string} next - 目标目录
       * @returns {Promise<void>} 完成
       */
      const chooseCwd = async (next) => {
        pinnedCwd = next
        setCwd(next)
        await reload()
      }

      /**
       * 切换启停。
       * @param {object} skill - 技能记录
       * @param {boolean|null} next - 目标状态
       * @returns {Promise<void>} 完成
       */
      const toggle = useCallback(
        async (skill, next) => {
          const response = await request('/policy', { rootKey: skill.rootKey, name: skill.name, enabled: next }).catch((failure) => ({
            ok: false,
            error: String(failure),
          }))
          if (!response.ok) setError(response.error ?? '设置失败')
          else setError(null)
          await reload()
        },
        [reload],
      )

      /**
       * 打开编辑器。
       * @param {object} skill - 技能记录
       * @returns {Promise<void>} 完成
       */
      const openEditor = useCallback(async (skill) => {
        const response = await request(`/skill/content?rootKey=${encodeURIComponent(skill.rootKey)}&name=${encodeURIComponent(skill.name)}`)
        if (!response.ok) {
          setError(response.error ?? '无法读取正文')
          return
        }
        setEditor({ skill, ...response })
      }, [])

      const roots = data ? data.roots : []
      const skills = useMemo(() => {
        if (!data) return []
        if (filter === 'all') return data.skills
        return data.skills.filter((skill) => skill.rootKey === filter)
      }, [data, filter])

      const selectedSkill = data && selected ? data.skills.find((skill) => skill.docPath === selected) : null
      const siblings = data && selectedSkill ? data.skills.filter((skill) => skill.name === selectedSkill.name) : []
      const writeRoot = roots.find((root) => root.source === 'user-dsh') ?? roots.find((root) => root.mutable)
      const candidates = data && Array.isArray(data.candidates) ? data.candidates : []

      if (!data && !error) return h('div', { className: 'dshsm-section' }, h('p', { className: 'dshsm-hint' }, '正在读取技能目录…'))

      return h(
        'div',
        { className: 'dshsm-section' },

        h(
          'div',
          { className: 'dshsm-scope' },
          h('span', null, '项目根按'),
          candidates.length > 1
            ? h(ScopeSelect, { value: cwd ?? '', options: candidates, onChange: chooseCwd })
            : h('code', null, cwd ?? '（未知）'),
          h('span', { className: 'dshsm-scope-hint' }, '解析 .dsh/skills 与 .agents/skills；换目录会改变项目级技能'),
        ),
        error ? h('div', { className: 'dshsm-notice dshsm-notice--danger' }, error) : null,
        data && data.damaged ? h('div', { className: 'dshsm-notice dshsm-notice--warn' }, data.damaged) : null,
        divergenceNotice(registry ? registry.divergence : null),
        mode === 'create'
          ? h(CreateForm, {
              rootKey: writeRoot ? writeRoot.key : '',
              rootPath: writeRoot ? writeRoot.path : '（没有可写的技能根目录）',
              onDone: async () => {
                setMode(null)
                await reload()
              },
              onCancel: () => setMode(null),
            })
          : null,
        mode === 'import'
          ? h(ImportForm, {
              rootKey: writeRoot ? writeRoot.key : '',
              onDone: async () => {
                setMode(null)
                await reload()
              },
              onCancel: () => setMode(null),
            })
          : null,
        editor
          ? h(Editor, {
              name: editor.skill.name,
              rootKey: editor.skill.rootKey,
              docPath: editor.path,
              content: editor.content,
              onSaved: async () => {
                setEditor(null)
                await reload()
              },
              onCancel: () => setEditor(null),
            })
          : null,
        !editor && !mode
          ? h(
              'div',
              { className: 'dshsm-block' },
              h(
                'div',
                { className: 'dshsm-roots' },
                h('button', { type: 'button', className: `dshsm-chip${filter === 'all' ? ' dshsm-chip--active' : ''}`, onClick: () => setFilter('all') }, '全部'),
                roots.map((root) =>
                  h(
                    'button',
                    {
                      key: root.key,
                      type: 'button',
                      className: `dshsm-chip${filter === root.key ? ' dshsm-chip--active' : ''}${root.exists ? '' : ' dshsm-chip--empty'}`,
                      title: root.path,
                      onClick: () => setFilter(root.key),
                    },
                    `${root.source} · ${root.skills.filter((s) => s.winner).length}${root.exists ? '' : '（目录不存在）'}`,
                  ),
                ),
              ),
              // 整宽单列卡片：和「插件」「模型」两页一个语言。之前把列表塞进 340px 的窄栏，
              // 名字、描述、路径全被截断 —— 横向空间本来就够，不该分栏。
              // 点卡片在**卡片内部**展开详情，而不是挤到旁边一栏去。
              h(
                'div',
                { className: 'dshsm-list-wrap' },
                skills.filter((skill) => skill.winner).length === 0
                  ? h('p', { className: 'dshsm-empty' }, '这个范围内没有技能。')
                  : skills
                      .filter((skill) => skill.winner)
                      .map((skill) =>
                        h(
                          'div',
                          { key: skill.docPath, className: 'dshsm-item' },
                          h(SkillRow, {
                            skill,
                            selected: selected === skill.docPath,
                            // 再点一次收起 —— 展开态是一个可切换的东西，不是「选中后不可取消」。
                            onSelect: () => setSelected(selected === skill.docPath ? null : skill.docPath),
                            onToggle: toggle,
                          }),
                          selected === skill.docPath
                            ? h(Detail, {
                                skill,
                                siblings,
                                onEdit: () => openEditor(skill),
                                onToggle: toggle,
                                onDelete: async () => {
                                  // 没有回收站了，这一下就是永久删除 —— 所以必须问一句。
                                  const response = await request('/skill/delete', { rootKey: skill.rootKey, name: skill.name })
                                  if (!response.ok) setError(response.error ?? '删除失败')
                                  setSelected(null)
                                  await reload()
                                },
                              })
                            : null,
                        ),
                      ),
              ),
              skills.filter((skill) => !skill.winner).length > 0
                ? h(
                    'details',
                    { className: 'dshsm-shadowed' },
                    h('summary', null, `${skills.filter((skill) => !skill.winner).length} 条被同名技能遮蔽`),
                    skills
                      .filter((skill) => !skill.winner)
                      .map((skill) =>
                        h(SkillRow, {
                          key: skill.docPath,
                          skill,
                          selected: false,
                          onSelect: () => {},
                          onToggle: toggle,
                        }),
                      ),
                  )
                : null,
              // 添加入口放在列表下面，用整宽虚线按钮 —— 和「模型」页的「添加提供方」一个语言。
              h(
                'div',
                { className: 'dshsm-addRow' },
                h('button', { type: 'button', className: 'dshsm-addButton', onClick: () => setMode('create'), disabled: !writeRoot }, '＋ 新建技能'),
                h('button', { type: 'button', className: 'dshsm-addButton', onClick: () => setMode('import'), disabled: !writeRoot }, '＋ 导入技能'),
              ),
              h(
                'p',
                { className: 'dshsm-foot' },
                '启停只改变 DSH 里的调用策略，源文件不会被改动。这里显示的是 DSH 注册表的真实裁决结果。',
                data && data.logPath ? ` 操作日志：${data.logPath}` : '',
              ),
            )
          : null,
        editor || mode
          ? h('p', { className: 'dshsm-foot' }, '编辑与新建只影响这一个技能；取消不会写入任何内容。')
          : null,
      )
    }

    /** 出错时只让这块面板塌掉，不带走整个设置页。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error !== null) {
          const message = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'dshsm-notice dshsm-notice--danger', role: 'alert' }, `技能面板出错：${message}`)
        }
        return this.props.children
      }
    }

    /** 注入样式表；已存在则复用。 */
    function injectStyle() {
      const existing = document.querySelector(`style[data-dshsm-css=${JSON.stringify(STYLE_ID)}]`)
      if (existing !== null) return null
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-skills-manager'
      tag.dataset.dshsmCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return tag
    }

    const name = 'dsh-skills-manager'

    /** 只依赖 slots；本面板的数据全部走自己的宿主路由，不用设置域。 */
    const inject = ['slots']

    /**
     * 注册「技能」设置分区。
     * @param {object} ctx - 浏览器插件上下文
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = injectStyle()
        return () => {
          if (tag !== null) tag.remove()
        }
      }, 'skills-manager: 样式表')
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-skills-manager',
            order: SECTION_ORDER,
            label: () => '技能',
            inject: () => ({}),
          },
          () => h(Boundary, null, h(SkillsSection, null)),
        ),
      )
    }

    /**
     * 样式表。
     *
     * 用半透明黑/白叠加而不是写死颜色，这样在 DSH 的浅色与深色主题下都可读，
     * 而不必依赖任何具体的主题变量名。
     */
    // 样式对齐 `@lolkda/dsh-prompt-manager`：同一套 `--dsw-alias-*` 设计令牌、同一套几何。
    // 关键不是"看起来像"，而是**颜色全部走令牌** —— 硬编码的 rgba 不会跟随明暗主题，
    // 这正是之前和设置里其它页面放在一起时最刺眼的地方。
    // 几何照抄：卡片 12/14px 内距 + .5px 发丝边 + 16px 圆角；按钮 28px 高（primary 32px）、
    // 圆角 14/16px；输入框 32px 高、8px 圆角；tab 是朴素文字加 2px 下划线。
    const CSS = `
.dshsm-section{max-width:760px;min-width:0;display:flex;flex-direction:column;gap:12px;padding-bottom:12px;color:var(--dsw-alias-label-primary)}

.dshsm-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dshsm-scope{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dshsm-scope code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px}
/* 下拉：几何、圆角、令牌逐条对齐 DSH 自己的选择器（36px 高 / 18px 圆角 / 无边框 /
   模块底色，hover 用 interactive-bg-hover），而不是原生控件的观感。 */
.dshsm-select{position:relative;display:inline-flex;min-width:0}
.dshsm-select__trigger{display:inline-flex;align-items:center;gap:12px;height:36px;max-width:52ch;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.dshsm-select__trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsm-select__value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:13px}
.dshsm-select__chevron{flex:none}
/* 阴影用 shell 的 --dsw-elevation-prominent；它最外面那层描边的颜色由
   --dsw-elevation-stroke-color 决定，不设就会落到一个更黑的默认值（实测 .16 vs .04），
   所以照 DSH 的菜单规则把它一起设上。 */
.dshsm-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:100;box-sizing:border-box;display:flex;flex-direction:column;min-width:218px;max-width:360px;padding:4px;border:0;border-radius:20px;background:var(--dsw-specific-menu,#fff);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px rgba(0,0,0,.04),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05))}
.dshsm-menu__item{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:14px;line-height:22px;text-align:left}
.dshsm-menu__item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsm-menu__label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsm-menu__check{flex:none}
.dshsm-scope-hint{color:var(--dsw-alias-label-quaternary)}

/* tab 行：朴素文字，选中的加下划线，底下一条发丝线 */
.dshsm-tabs{display:flex;align-items:flex-end;gap:22px;margin-top:2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshsm-tab{position:relative;background:0 0;border:0;padding:7px 1px 9px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshsm-tab:hover{color:var(--dsw-alias-label-primary)}
.dshsm-tab--active{color:var(--dsw-alias-label-primary)}
.dshsm-tab--active:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}

.dshsm-block{display:flex;flex-direction:column;gap:12px;min-width:0}
.dshsm-roots{display:flex;flex-wrap:wrap;gap:6px}

/* 根筛选：按钮形态，与提示词页的按钮同一套几何 */
.dshsm-chip{box-sizing:border-box;height:28px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}
.dshsm-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsm-chip--active{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.dshsm-chip--empty{color:var(--dsw-alias-label-quaternary)}

/* 一条技能 = 一张整宽的卡，和「插件」「模型」两页一样。
   展开的详情是**这张卡的下半部分**：共用外框，用虚线分隔 + 平台模块底色做嵌面，
   而不是把详情挤到旁边一栏去。 */
.dshsm-list-wrap{display:flex;flex-direction:column;gap:8px;min-width:0}
.dshsm-item{display:flex;flex-direction:column;min-width:0}
.dshsm-item>.dshsm-row:not(:last-child){border-bottom-left-radius:0;border-bottom-right-radius:0}
.dshsm-row{display:flex;align-items:center;gap:10px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;min-width:0}
.dshsm-row--selected{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshsm-row--shadowed{opacity:.6}
.dshsm-row__main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;margin:0;padding:0;background:0 0;border:0;text-align:left;color:inherit;font:inherit;cursor:pointer}
.dshsm-row__title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
/* 标题用正文黑体，不用等宽 —— 「插件」「模型」两页的卡标题都是正常字体，
   等宽留着给路径这类真正需要对齐的东西（.dshsm-row__meta）。 */
.dshsm-name{font-family:inherit;font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsm-row__desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dshsm-row__meta{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-quaternary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsm-row__action{display:inline-flex;align-items:center;gap:8px;margin-left:auto;flex:0 0 auto}

/* 小徽章，与提示词页的 badge 一致 */
.dshsm-pill{flex:0 0 auto;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshsm-pill--warn{border-style:dashed;color:var(--dsw-alias-state-warn-primary)}
.dshsm-pill--danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dshsm-pill--source{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dshsm-pill--off{color:var(--dsw-alias-label-quaternary)}

/* 开关：提示词页没有这个控件，用同一套令牌自造一个 */
.dshsm-switch{position:relative;flex:0 0 auto;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
/* 打开态用主文字色，和提示词页的开关一致（深色药丸 + 反色圆钮）；绿色留给状态圆点。 */
.dshsm-switch--on{background:var(--dsw-alias-label-primary)}
.dshsm-switch:disabled{opacity:.5;cursor:default}
.dshsm-switch__knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .15s ease}
.dshsm-switch--on .dshsm-switch__knob{left:18px}

/* 详情：卡片的下半部分，与上半部分共用外框 */
.dshsm-detail{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;min-width:0}
.dshsm-item>.dshsm-detail{margin-top:-.5px;border-top-left-radius:0;border-top-right-radius:0;border-top-style:dashed;background:var(--dsw-alias-bg-module-platform)}
.dshsm-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:0;font-size:12px;line-height:18px}
.dshsm-kv dt{color:var(--dsw-alias-label-tertiary)}
.dshsm-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}

/* 提示块：用平台模块底色做嵌面，语气靠文字色表达（和提示词页的 status 一致） */
.dshsm-notice{display:flex;flex-direction:column;gap:6px;min-width:0;margin:0;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-module-platform);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshsm-notice--ok{color:var(--dsw-alias-state-success-primary)}
.dshsm-notice--warn{color:var(--dsw-alias-state-warn-primary)}
.dshsm-notice--danger{color:var(--dsw-alias-state-error-primary)}
.dshsm-list{margin:0;padding-left:18px}
.dshsm-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshsm-confirm{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshsm-confirm__text{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}

/* 按钮：三种形态，与提示词页一致 */
.dshsm-btn{box-sizing:border-box;height:28px;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}
.dshsm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshsm-btn:disabled{color:var(--dsw-alias-label-quaternary);border-color:var(--dsw-alias-border-l4);cursor:default}
.dshsm-btn--primary{height:32px;padding:0 14px;border-radius:16px;border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:13px}
.dshsm-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshsm-btn--primary:disabled{background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-quaternary)}
.dshsm-btn--danger{color:var(--dsw-alias-state-error-primary)}
.dshsm-btn--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}

/* 添加入口：整宽虚线按钮，照「模型」页的「添加提供方」那一行。
   两列定宽而非 flex-wrap —— 换行阈值不该随着窗口差几个像素就改行数。 */
.dshsm-addRow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.dshsm-addRow>:last-child:nth-child(odd){grid-column:1/-1}
.dshsm-addButton{height:44px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px dashed var(--dsw-alias-border-l3);border-radius:16px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dshsm-addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshsm-addButton:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}

/* 空列表：虚线框居中，照提示词页的空态 */
.dshsm-empty{margin:0;padding:14px;border:.5px dashed var(--dsw-alias-border-l3);border-radius:16px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary)}

.dshsm-editor,.dshsm-form{display:flex;flex-direction:column;gap:12px;min-width:0}
.dshsm-editor__head{margin:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-quaternary);overflow-wrap:anywhere}
.dshsm-textarea{box-sizing:border-box;width:100%;min-height:300px;resize:vertical;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px}
.dshsm-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dshsm-textarea--short{min-height:140px}

.dshsm-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
/* 表单里占满整行的字段（正文），其余字段并排。 */
.dshsm-field--wide{width:100%;flex:1 1 100%}
.dshsm-field input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dshsm-field input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dshsm-check{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px}
.dshsm-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-quaternary)}
.dshsm-foot{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-quaternary)}
.dshsm-shadowed{margin-top:8px}
.dshsm-shadowed summary{cursor:pointer;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
`

    return { name, inject, apply }
  },
})
