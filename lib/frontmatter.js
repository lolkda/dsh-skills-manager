/**
 * SKILL.md 文档的读取与校验。
 *
 * 有意零依赖、只读：本插件从不改写源技能文件的 frontmatter —— 启停是通过注册表
 * 策略覆盖实现的（见 provider.js），改文件只在「新建 / 导入 / 用户显式编辑正文」
 * 这三条显式路径上发生，且写入的是调用方给的整份文本。
 *
 * 因此这里只需要一个**有界的 YAML 子集**解析器：顶层标量、引号标量、块标量，
 * 足以取出 name / description / whenToUse / 两个调用键。嵌套映射（如 metadata）
 * 只被识别为「存在此键」，不解析其内容 —— 我们不需要它，也不需要把它写回去。
 *
 * 校验语义刻意对齐 `@deepseek-ai/dsh-skill-filesystem`：name 必须是 kebab-case、
 * description 必填、两个调用键的非法拼写会让整条技能作废（而不是静默允许某个接口）。
 * 我们对「作废」的处理是标为不可加载并给出诊断，因为本插件面向的是**查看与修复**，
 * 把坏掉的技能展示出来正是它的价值。
 */

/** 合法的技能名文法，与注册表 `isSkillName` 同一形状。 */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 顶层 `key: value` 行。键允许点号与下划线，值可缺省。 */
const KEY_RE = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/

/** 块标量头部：`|`、`|-`、`|+`、`>`、`>-`、`>+`。 */
const BLOCK_SCALAR_RE = /^[|>][+-]?$/

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])

/**
 * 判断字符串是否是合法技能名。
 * @param {unknown} name - 待判定的名字
 * @returns {boolean} 是否匹配 kebab-case 文法
 */
export function isSkillName(name) {
  return typeof name === 'string' && KEBAB_RE.test(name)
}

/**
 * 把任意用户输入规范成 kebab-case 技能名。
 *
 * 中英文之间的边界也当作分隔：`我的 Skill` → `我的-skill` 在 YAML/路径上仍然合法
 * 但不是 kebab-case，所以非 ASCII 字符被折叠为分隔符 —— 名字会退化成可用形式，
 * 而不是产生一个注册表会拒收的条目。
 * @param {unknown} input - 用户输入的名字
 * @returns {string} 规范化后的名字；无法产出非空结果时返回空串
 */
export function normalizeSkillName(input) {
  if (typeof input !== 'string') return ''
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * 按 DSH 的严格布尔语法解析一个 frontmatter 值。
 *
 * 被引号包起来的 `"true"` 是 YAML 字符串而不是布尔值，因此**不**被接受 —— 这正是
 * `dsh-skill-filesystem` 的行为，声明为 `invocationPolicyValid: false` 的原因。
 * @param {string} value - 原始标量文本（已去引号前的形态由调用方保证）
 * @param {boolean} quoted - 该值是否被引号包裹
 * @returns {boolean|undefined} 解析结果；无法判定时为 undefined
 */
export function parseBoolean(value, quoted) {
  if (quoted) return undefined
  if (typeof value !== 'string') return undefined
  const word = value.trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return true
  if (FALSE_WORDS.has(word)) return false
  return undefined
}

/**
 * 去掉一层引号并处理转义。
 * @param {string} value - 原始标量文本
 * @returns {{ text: string, quoted: boolean }} 解引号后的文本与是否曾被引用
 */
function unquote(value) {
  const text = value.trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = text.slice(1, -1)
      return first === '"'
        ? { text: inner.replace(/\\(["\\/nrt])/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c)), quoted: true }
        : { text: inner.replace(/''/g, "'"), quoted: true }
    }
  }
  return { text, quoted: false }
}

/**
 * 把一份文档切成 frontmatter 块与正文。
 *
 * frontmatter 必须从**第一行**开始（允许 UTF-8 BOM 与 CRLF），并以独占一行的
 * `---` 或 `...` 结束。没有起始分隔符时整份文本都是正文。
 * @param {string} text - 文件原始内容
 * @returns {{ hasFrontmatter: boolean, frontmatter: string, body: string, closed: boolean }}
 *   `closed` 为 false 表示有起始分隔符却没有结束分隔符（该文件不可加载）
 */
export function splitDocument(text) {
  const source = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  const match = /^(---|\+\+\+)[ \t]*\r?\n/.exec(source)
  if (!match) return { hasFrontmatter: false, frontmatter: '', body: source, closed: false }
  const openLength = match[0].length
  const rest = source.slice(openLength)
  const lines = rest.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '---' || line === '...') {
      const frontmatter = lines.slice(0, i).join('\n')
      const body = lines.slice(i + 1).join('\n')
      return { hasFrontmatter: true, frontmatter, body, closed: true }
    }
  }
  return { hasFrontmatter: true, frontmatter: rest, body: '', closed: false }
}

/**
 * 解析 frontmatter 里的顶层标量键。
 *
 * 已知的取舍：嵌套映射（`metadata:` 及其缩进子行）被识别为「该键存在且非标量」，
 * 但不解析内部结构；本插件不读取 metadata，也不写回 frontmatter，所以这个缺口
 * 不会造成可见的功能损失。
 * @param {string} raw - frontmatter 块（不含分隔符）
 * @returns {{ entries: Map<string, { value: string, quoted: boolean }>, diagnostics: Array<object> }}
 */
export function parseFrontmatter(raw) {
  const entries = new Map()
  const diagnostics = []
  const lines = typeof raw === 'string' ? raw.split(/\r?\n/) : []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    // 缩进行属于上一个键的块或映射，已由该键的处理消费。
    if (/^[ \t]/.test(line)) continue
    const match = KEY_RE.exec(line)
    if (!match) {
      diagnostics.push({ level: 'warn', code: 'frontmatter.line', line: i + 1, message: `无法解析 frontmatter 第 ${i + 1} 行` })
      continue
    }
    const key = match[1]
    const inline = (match[2] ?? '').trim()
    if (inline === '' ) {
      // `key:` —— 后跟缩进块时是映射或块标量；两种都不解析，仅登记该键存在。
      entries.set(key, { value: '', quoted: false })
      continue
    }
    if (BLOCK_SCALAR_RE.test(inline)) {
      const collected = []
      let j = i + 1
      const indent = detectIndent(lines, j)
      for (; j < lines.length; j++) {
        const next = lines[j]
        if (next.trim() === '') {
          collected.push('')
          continue
        }
        if (!/^[ \t]/.test(next)) break
        collected.push(indent > 0 ? next.slice(Math.min(indent, next.length)) : next.replace(/^[ \t]+/, ''))
      }
      i = j - 1
      const folded = inline[0] === '>'
      const text = collected.join('\n').replace(/\n+$/, '')
      entries.set(key, { value: stripChomp(folded ? text.replace(/(?<!\n)\n(?!\n)/g, ' ') : text, inline), quoted: false })
      continue
    }
    const { text, quoted } = unquote(inline)
    entries.set(key, { value: text, quoted })
  }
  return { entries, diagnostics }
}

/** 取块标量首个非空行的缩进宽度。 */
function detectIndent(lines, from) {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const match = /^[ \t]*/.exec(line)
    return match ? match[0].length : 0
  }
  return 0
}

/** 处理块标量的 chomp 指示符（`-` 去掉末尾换行，`+` 保留，缺省保留单个）。 */
function stripChomp(text, header) {
  if (header.endsWith('-')) return text.replace(/\n+$/, '')
  return text
}

/**
 * 读取一份技能文档并给出与注册表一致的判定。
 * @param {string} text - 文件原始内容
 * @returns {{
 *   hasFrontmatter: boolean,
 *   closed: boolean,
 *   name: string,
 *   description: string,
 *   whenToUse: string|undefined,
 *   modelInvocable: boolean,
 *   userInvocable: boolean,
 *   invocationPolicyValid: boolean,
 *   frontmatterKeys: string[],
 *   body: string,
 *   loadable: boolean,
 *   diagnostics: Array<{ level: string, code: string, message: string }>
 * }} 文档摘要
 */
export function readSkillDocument(text) {
  const { hasFrontmatter, frontmatter, body, closed } = splitDocument(text)
  const diagnostics = []
  if (!hasFrontmatter) {
    diagnostics.push({ level: 'error', code: 'frontmatter.missing', message: '缺少 YAML frontmatter：文件必须以 --- 开头' })
    return finish({ name: '', description: '', whenToUse: undefined, modelInvocable: true, userInvocable: true, invocationPolicyValid: true, body, frontmatterKeys: [] })
  }
  if (!closed) {
    diagnostics.push({ level: 'error', code: 'frontmatter.unclosed', message: 'frontmatter 没有结束分隔符 ---' })
  }
  const { entries, diagnostics: parseDiagnostics } = parseFrontmatter(frontmatter)
  diagnostics.push(...parseDiagnostics)

  const name = entries.get('name')?.value ?? ''
  const description = entries.get('description')?.value ?? ''
  const whenToUse = entries.get('whenToUse')?.value

  if (!name) {
    diagnostics.push({ level: 'error', code: 'name.missing', message: '缺少必填的 name' })
  } else if (!isSkillName(name)) {
    diagnostics.push({ level: 'error', code: 'name.invalid', message: `name "${name}" 不是合法的 kebab-case 技能名` })
  }
  if (!description.trim()) {
    diagnostics.push({ level: 'error', code: 'description.missing', message: '缺少必填的 description' })
  }

  const modelEntry = entries.get('disable-model-invocation')
  const userEntry = entries.get('user-invocable')
  const modelValue = modelEntry ? parseBoolean(modelEntry.value, modelEntry.quoted) : undefined
  const userValue = userEntry ? parseBoolean(userEntry.value, userEntry.quoted) : undefined
  const invocationPolicyValid =
    (modelEntry === undefined || modelValue !== undefined) && (userEntry === undefined || userValue !== undefined)
  if (!invocationPolicyValid) {
    diagnostics.push({
      level: 'error',
      code: 'invocation.invalid',
      message: 'disable-model-invocation / user-invocable 的取值不是布尔值（引用形式的 "true" 也算非法），该技能会被注册表丢弃',
    })
  }

  return finish({
    name,
    description,
    whenToUse,
    // 两个键的极性相反：`disable-model-invocation: true` 表示**不可**被模型调用，
    // 而 `user-invocable: false` 本身就表示不可被用户调用。写反会让方向相反的
    // 策略在 UI 上显示成同一个状态，是本模块最容易出错的一处。
    modelInvocable: modelValue === undefined ? true : !modelValue,
    userInvocable: userValue === undefined ? true : userValue,
    invocationPolicyValid,
    body,
    frontmatterKeys: [...entries.keys()],
  })

  /**
   * 汇总返回值，并据诊断是否含 error 计算 loadable。
   * @param {object} partial - 已解析出的字段
   * @returns {object} 完整摘要
   */
  function finish(partial) {
    const loadable =
      partial.invocationPolicyValid &&
      isSkillName(partial.name) &&
      partial.description.trim().length > 0 &&
      closed
    return {
      hasFrontmatter,
      closed,
      whenToUse: undefined,
      frontmatterKeys: [],
      ...partial,
      loadable,
      diagnostics,
    }
  }
}

/**
 * 生成一份新的技能文档。
 *
 * description 与 whenToUse 用双引号包裹并转义，避免用户写进 `:`、`#` 或前导 `-`
 * 时产出非法 YAML；这两个字段的值因此总是字符串，不会意外变成布尔或数字。
 * @param {{ name: string, description: string, whenToUse?: string, body?: string }} input - 技能内容
 * @returns {string} 可直接写盘的完整文档
 */
export function buildSkillDocument(input) {
  const name = normalizeSkillName(input.name)
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const whenToUse = typeof input.whenToUse === 'string' ? input.whenToUse.trim() : ''
  const body = typeof input.body === 'string' ? input.body.replace(/^\n+/, '') : ''
  const lines = ['---', `name: ${name}`, `description: ${quote(description)}`]
  if (whenToUse) lines.push(`whenToUse: ${quote(whenToUse)}`)
  lines.push('---', '')
  return `${lines.join('\n')}${body}`
}

/**
 * 用双引号包裹一个 YAML 标量。
 * @param {string} value - 原始文本
 * @returns {string} 可安全放进 `key: ` 后面的标量
 */
function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
