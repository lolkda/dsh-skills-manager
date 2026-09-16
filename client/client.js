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
    const { useCallback, useEffect, useMemo, useState } = React

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
      const overridden = skill.override === true || skill.override === false
      return h(
        'div',
        { className: 'dshsm-detail' },
        h('h4', { className: 'dshsm-detail__title' }, skill.name),
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
          h('button', { type: 'button', className: 'dshsm-btn', onClick: props.onEdit, disabled: !skill.mutable }, '编辑正文'),
          overridden
            ? h('button', { type: 'button', className: 'dshsm-btn', onClick: () => props.onToggle(skill, null) }, '恢复文件设定')
            : null,
          h(
            'button',
            { type: 'button', className: 'dshsm-btn dshsm-btn--danger', onClick: props.onTrash, disabled: !skill.mutable },
            '移到回收站',
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

    /** 回收站。 */
    function TrashPanel(props) {
      const [busy, setBusy] = useState(null)
      /**
       * 恢复或永久删除。
       * @param {object} item - 回收站条目
       * @param {string} action - restore 或 purge
       * @returns {Promise<void>} 完成
       */
      const act = async (item, action) => {
        setBusy(item.id)
        const response = await request(`/trash/${action}`, { id: item.id }).catch(() => ({ ok: false }))
        setBusy(null)
        if (response.ok) props.onChanged()
        else props.onError(response.error ?? '操作失败')
      }
      if (props.items.length === 0) return h('p', { className: 'dshsm-hint' }, '回收站是空的。删除技能只会移到这里，随时可以恢复。')
      return h(
        'div',
        { className: 'dshsm-list-wrap' },
        props.items.map((item) =>
          h(
            'div',
            { className: 'dshsm-row', key: item.id },
            h(
              'div',
              { className: 'dshsm-row__main' },
              h('div', { className: 'dshsm-row__title' }, h('code', { className: 'dshsm-name' }, item.name), h(Pill, { tone: 'muted' }, item.source)),
              h('div', { className: 'dshsm-row__meta' }, `${item.originalPath} · ${String(item.deletedAt).replace('T', ' ').slice(0, 19)}`),
            ),
            h(
              'div',
              { className: 'dshsm-row__action' },
              h('button', { type: 'button', className: 'dshsm-btn', disabled: busy === item.id, onClick: () => act(item, 'restore') }, '恢复'),
              h('button', { type: 'button', className: 'dshsm-btn dshsm-btn--danger', disabled: busy === item.id, onClick: () => act(item, 'purge') }, '永久删除'),
            ),
          ),
        ),
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
      const [tab, setTab] = useState('skills')
      const [filter, setFilter] = useState('all')
      const [query, setQuery] = useState('')
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
        const needle = query.trim().toLowerCase()
        return data.skills.filter((skill) => {
          if (filter !== 'all' && skill.rootKey !== filter) return false
          if (!needle) return true
          return skill.name.toLowerCase().includes(needle) || String(skill.description).toLowerCase().includes(needle)
        })
      }, [data, filter, query])

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
          { className: 'dshsm-bar' },
          h(
            'div',
            { className: 'dshsm-tabs' },
            h('button', { type: 'button', className: `dshsm-tab${tab === 'skills' ? ' dshsm-tab--active' : ''}`, onClick: () => setTab('skills') }, `技能 ${data ? data.skills.filter((s) => s.winner).length : ''}`),
            h('button', { type: 'button', className: `dshsm-tab${tab === 'trash' ? ' dshsm-tab--active' : ''}`, onClick: () => setTab('trash') }, `回收站 ${data && data.trash.length > 0 ? data.trash.length : ''}`),
          ),
          tab === 'skills'
            ? h('input', { className: 'dshsm-search', placeholder: '搜索名字或描述', value: query, onChange: (event) => setQuery(event.target.value) })
            : null,
        ),
        h(
          'div',
          { className: 'dshsm-scope' },
          h('span', null, '项目根按'),
          candidates.length > 1
            ? h(
                'select',
                { className: 'dshsm-scope-select', value: cwd ?? '', onChange: (event) => chooseCwd(event.target.value) },
                candidates.map((item) => h('option', { key: item, value: item }, item)),
              )
            : h('code', null, cwd ?? '（未知）'),
          h('span', { className: 'dshsm-scope-hint' }, '解析 .dsh/skills 与 .agents/skills；换目录会改变项目级技能'),
        ),
        error ? h('div', { className: 'dshsm-notice dshsm-notice--danger' }, error) : null,
        data && data.damaged ? h('div', { className: 'dshsm-notice dshsm-notice--warn' }, data.damaged) : null,
        divergenceNotice(registry ? registry.divergence : null),
        tab === 'trash' ? h(TrashPanel, { items: data ? data.trash : [], onChanged: reload, onError: setError }) : null,
        tab === 'skills' && mode === 'create'
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
        tab === 'skills' && mode === 'import'
          ? h(ImportForm, {
              rootKey: writeRoot ? writeRoot.key : '',
              onDone: async () => {
                setMode(null)
                await reload()
              },
              onCancel: () => setMode(null),
            })
          : null,
        tab === 'skills' && editor
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
        tab === 'skills' && !editor && !mode
          ? h(
              'div',
              { className: 'dshsm-body' },
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
              h(
                'div',
                { className: 'dshsm-main' },
                h(
                  'div',
                  { className: 'dshsm-list-wrap' },
                  skills.filter((skill) => skill.winner).length === 0
                    ? h('p', { className: 'dshsm-hint' }, '这个范围内没有技能。')
                    : skills
                        .filter((skill) => skill.winner)
                        .map((skill) =>
                          h(SkillRow, {
                            key: skill.docPath,
                            skill,
                            selected: selected === skill.docPath,
                            onSelect: () => setSelected(skill.docPath),
                            onToggle: toggle,
                          }),
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
                              selected: selected === skill.docPath,
                              onSelect: () => setSelected(skill.docPath),
                              onToggle: toggle,
                            }),
                          ),
                      )
                    : null,
                ),
                h(
                  'div',
                  { className: 'dshsm-side' },
                  selectedSkill
                    ? h(Detail, {
                        skill: selectedSkill,
                        siblings,
                        onEdit: () => openEditor(selectedSkill),
                        onToggle: toggle,
                        onTrash: async () => {
                          const response = await request('/skill/trash', { rootKey: selectedSkill.rootKey, name: selectedSkill.name })
                          if (!response.ok) setError(response.error ?? '删除失败')
                          setSelected(null)
                          await reload()
                        },
                      })
                    : h(
                        'div',
                        { className: 'dshsm-detail dshsm-detail--empty' },
                        h('p', { className: 'dshsm-hint' }, '选一条技能查看来源、遮蔽关系与诊断。'),
                        h(
                          'div',
                          { className: 'dshsm-actions' },
                          h('button', { type: 'button', className: 'dshsm-btn dshsm-btn--primary', onClick: () => setMode('create'), disabled: !writeRoot }, '新建技能'),
                          h('button', { type: 'button', className: 'dshsm-btn', onClick: () => setMode('import'), disabled: !writeRoot }, '导入技能'),
                        ),
                      ),
                ),
              ),
              h(
                'p',
                { className: 'dshsm-foot' },
                '启停只改变 DSH 里的调用策略，源文件不会被改动。这里显示的是 DSH 注册表的真实裁决结果。',
                data && data.logPath ? ` 操作日志：${data.logPath}` : '',
              ),
            )
          : null,
        tab === 'skills' && (editor || mode)
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
.dshsm-scope-select{box-sizing:border-box;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;max-width:52ch}
.dshsm-scope-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dshsm-scope-hint{color:var(--dsw-alias-label-quaternary)}

/* tab 行：朴素文字，选中的加下划线，底下一条发丝线 */
.dshsm-tabs{display:flex;align-items:flex-end;gap:22px;margin-top:2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshsm-tab{position:relative;background:0 0;border:0;padding:7px 1px 9px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshsm-tab:hover{color:var(--dsw-alias-label-primary)}
.dshsm-tab--active{color:var(--dsw-alias-label-primary)}
.dshsm-tab--active:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}

.dshsm-search{box-sizing:border-box;flex:0 1 240px;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dshsm-search:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dshsm-search::placeholder{color:var(--dsw-alias-label-quaternary)}

.dshsm-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:16px;align-items:start}
@media (max-width:680px){.dshsm-body{grid-template-columns:minmax(0,1fr)}}
/* 网格项默认 min-width:auto，会撑破行内的省略号（描述、路径都得能收缩）。 */
.dshsm-main,.dshsm-side{min-width:0}
.dshsm-roots{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px}

/* 根筛选：按钮形态，与提示词页的按钮同一套几何 */
.dshsm-chip{box-sizing:border-box;height:28px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}
.dshsm-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsm-chip--active{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.dshsm-chip--empty{color:var(--dsw-alias-label-quaternary)}

/* 一条技能 = 一张卡，与提示词页的行卡一致 */
.dshsm-list-wrap{display:flex;flex-direction:column;gap:8px;min-width:0}
.dshsm-row{display:flex;align-items:center;gap:10px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;min-width:0}
.dshsm-row--selected{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshsm-row--shadowed{opacity:.6}
.dshsm-row__main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;margin:0;padding:0;background:0 0;border:0;text-align:left;color:inherit;font:inherit;cursor:pointer}
.dshsm-row__title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dshsm-name{font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsm-row__desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
.dshsm-switch--on{background:var(--dsw-alias-state-success-primary)}
.dshsm-switch:disabled{opacity:.5;cursor:default}
.dshsm-switch__knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .15s ease}
.dshsm-switch--on .dshsm-switch__knob{left:18px}

/* 详情面板，与提示词页的行卡同一套几何 */
.dshsm-detail{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;min-width:0}
.dshsm-detail--empty{border-style:dashed;align-items:center;text-align:center}
.dshsm-detail__title{margin:0;font-size:14px;font-weight:500;line-height:22px;overflow-wrap:anywhere}
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

/* 按钮：三种形态，与提示词页一致 */
.dshsm-btn{box-sizing:border-box;height:28px;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}
.dshsm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshsm-btn:disabled{color:var(--dsw-alias-label-quaternary);border-color:var(--dsw-alias-border-l4);cursor:default}
.dshsm-btn--primary{height:32px;padding:0 14px;border-radius:16px;border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:13px}
.dshsm-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshsm-btn--primary:disabled{background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-quaternary)}
.dshsm-btn--danger{color:var(--dsw-alias-state-error-primary)}
.dshsm-btn--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}

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
