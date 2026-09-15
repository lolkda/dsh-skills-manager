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
    const ROUTE = '/api/dsh-skills-manager'

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
    async function request(path, body) {
      const response = await fetch(`${ROUTE}${path}`, {
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
    function SkillsSection() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [tab, setTab] = useState('skills')
      const [filter, setFilter] = useState('all')
      const [query, setQuery] = useState('')
      const [selected, setSelected] = useState(null)
      const [mode, setMode] = useState(null)
      const [editor, setEditor] = useState(null)

      /**
       * 重新拉取目录。
       * @returns {Promise<void>} 完成
       */
      const reload = useCallback(async () => {
        try {
          const response = await request('/catalog')
          if (!response.ok) {
            setError(response.error ?? '读取目录失败')
            return
          }
          setData(response.data)
          setError(null)
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        }
      }, [])

      useEffect(() => {
        reload()
      }, [reload])

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
        error ? h('div', { className: 'dshsm-notice dshsm-notice--danger' }, error) : null,
        data && data.damaged ? h('div', { className: 'dshsm-notice dshsm-notice--warn' }, data.damaged) : null,
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
    const CSS = `
.dshsm-section { display:flex; flex-direction:column; gap:12px; font-size:13px; }
.dshsm-bar { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
.dshsm-tabs { display:inline-flex; gap:4px; background:rgba(127,127,127,.12); padding:3px; border-radius:8px; }
.dshsm-tab { border:0; background:transparent; padding:5px 12px; border-radius:6px; cursor:pointer; font:inherit; color:inherit; opacity:.75; }
.dshsm-tab--active { background:rgba(127,127,127,.22); opacity:1; font-weight:600; }
.dshsm-search { flex:0 1 240px; padding:6px 10px; border-radius:8px; border:1px solid rgba(127,127,127,.35); background:transparent; color:inherit; font:inherit; }
.dshsm-body { display:grid; grid-template-columns:minmax(0,1fr) minmax(260px,340px); gap:16px; align-items:start; }
@media (max-width: 900px) { .dshsm-body { grid-template-columns:minmax(0,1fr); } }
.dshsm-roots { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:6px; }
.dshsm-chip { border:1px solid rgba(127,127,127,.3); background:transparent; color:inherit; padding:4px 10px; border-radius:999px; cursor:pointer; font:inherit; font-size:12px; opacity:.85; }
.dshsm-chip--active { background:rgba(127,127,127,.2); opacity:1; font-weight:600; }
.dshsm-chip--empty { opacity:.45; }
.dshsm-list-wrap { display:flex; flex-direction:column; gap:6px; min-width:0; }
.dshsm-row { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border-radius:10px; border:1px solid rgba(127,127,127,.2); }
.dshsm-row--selected { border-color:rgba(90,150,255,.75); background:rgba(90,150,255,.08); }
.dshsm-row--shadowed { opacity:.6; }
.dshsm-row__main { flex:1 1 auto; min-width:0; cursor:pointer; display:flex; flex-direction:column; gap:3px; }
.dshsm-row__title { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dshsm-name { font-weight:600; font-size:13px; }
.dshsm-row__desc { opacity:.8; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.dshsm-row__meta { opacity:.5; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshsm-row__action { display:flex; gap:6px; align-items:center; }
.dshsm-pill { font-size:11px; padding:1px 7px; border-radius:999px; background:rgba(127,127,127,.18); white-space:nowrap; }
.dshsm-pill--warn { background:rgba(230,170,40,.22); }
.dshsm-pill--danger { background:rgba(230,80,80,.2); }
.dshsm-pill--source { background:rgba(90,150,255,.2); }
.dshsm-switch { width:36px; height:20px; border-radius:999px; border:0; background:rgba(127,127,127,.4); position:relative; cursor:pointer; padding:0; flex:0 0 auto; }
.dshsm-switch--on { background:rgba(60,170,110,.85); }
.dshsm-switch:disabled { opacity:.4; cursor:not-allowed; }
.dshsm-switch__knob { position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s ease; }
.dshsm-switch--on .dshsm-switch__knob { left:18px; }
.dshsm-detail { border:1px solid rgba(127,127,127,.25); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:10px; min-width:0; }
.dshsm-detail--empty { border-style:dashed; }
.dshsm-detail__title { margin:0; font-size:14px; }
.dshsm-kv { display:grid; grid-template-columns:auto minmax(0,1fr); gap:4px 10px; margin:0; font-size:12px; }
.dshsm-kv dt { opacity:.6; }
.dshsm-kv dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.dshsm-notice { border-radius:8px; padding:8px 10px; font-size:12px; background:rgba(127,127,127,.12); }
.dshsm-notice--warn { background:rgba(230,170,40,.16); }
.dshsm-notice--danger { background:rgba(230,80,80,.14); }
.dshsm-list { margin:6px 0 0; padding-left:18px; }
.dshsm-actions { display:flex; gap:8px; flex-wrap:wrap; }
.dshsm-btn { border:1px solid rgba(127,127,127,.35); background:transparent; color:inherit; padding:5px 12px; border-radius:8px; cursor:pointer; font:inherit; font-size:12px; }
.dshsm-btn:hover:not(:disabled) { background:rgba(127,127,127,.14); }
.dshsm-btn:disabled { opacity:.45; cursor:not-allowed; }
.dshsm-btn--primary { background:rgba(90,150,255,.2); border-color:rgba(90,150,255,.5); }
.dshsm-btn--danger { border-color:rgba(230,80,80,.45); }
.dshsm-editor, .dshsm-form { display:flex; flex-direction:column; gap:10px; }
.dshsm-editor__head { font-size:11px; opacity:.6; overflow-wrap:anywhere; }
.dshsm-textarea { width:100%; min-height:320px; resize:vertical; padding:10px; border-radius:8px; border:1px solid rgba(127,127,127,.35); background:transparent; color:inherit; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; line-height:1.55; }
.dshsm-textarea--short { min-height:140px; }
.dshsm-field { display:flex; flex-direction:column; gap:4px; font-size:12px; }
.dshsm-field span { opacity:.7; }
.dshsm-field input { padding:6px 10px; border-radius:8px; border:1px solid rgba(127,127,127,.35); background:transparent; color:inherit; font:inherit; }
.dshsm-check { display:flex; align-items:center; gap:6px; font-size:12px; }
.dshsm-hint { opacity:.6; font-size:12px; margin:0; }
.dshsm-foot { opacity:.55; font-size:11px; margin:0; }
.dshsm-shadowed { margin-top:8px; }
.dshsm-shadowed summary { cursor:pointer; font-size:12px; opacity:.7; margin-bottom:6px; }
`

    return { name, inject, apply }
  },
})
