import { DEFAULT_CONFIG } from './config.ts'
import { HUMAN_INPUT_LIMITS } from './human-input.ts'
import type { HumanInputQuestion, HumanInputRequest } from './human-input.ts'
import { localeCopy } from './locale.ts'
import type { LarkLocale } from './locale.ts'

export const CARD_LIMITS = {
  maxBytes: 28 * 1024,
  maxSummaryRunes: 100,
  maxAnswerRunes: 6_000,
  maxVisibleTools: 3,
  maxToolNameRunes: 80,
  maxToolDetailRunes: 240,
  maxErrorRunes: 600,
  maxApprovalReasonRunes: 1_000,
  maxReasoningRunes: 1_000,
  maxReasoningLines: 12,
  maxVisibleTodos: 20,
  maxTodoRunes: 240,
} as const

const CARD_STYLE = {
  schema: '2.0',
  padding: '16px 16px 16px 16px',
  panelPadding: '12px 12px 12px 12px',
  panelHeaderPadding: '8px 8px 8px 8px',
  spacing: '12px',
  panelSpacing: '8px',
  panelBackground: 'bg-white',
  panelBorder: 'blue-100',
  panelRadius: '8px',
  panelChevron: 'down-small-ccm_outlined',
  panelChevronSize: '16px 16px',
  panelExpandedAngle: -180,
  normalText: 'normal_v2',
  metaText: 'notation',
  defaultTextSize: 'normal',
  mobileTextSize: 'normal',
  direction: 'vertical',
  alignLeft: 'left',
  alignTop: 'top',
  alignCenter: 'center',
  alignRight: 'right',
  widthWeighted: 'weighted',
  flexNone: 'none',
  noMargin: '0px 0px 0px 0px',
  tagMarkdown: 'markdown',
  tagDiv: 'div',
  tagDivider: 'hr',
  tagPanel: 'collapsible_panel',
  tagColumnSet: 'column_set',
  tagColumn: 'column',
  tagPlainText: 'plain_text',
  tagStandardIcon: 'standard_icon',
  tagButton: 'button',
  widthFill: 'fill',
  buttonMedium: 'medium',
  buttonPrimary: 'primary',
  buttonDefault: 'default',
  behaviorCallback: 'callback',
} as const

const CARD_ELEMENT = {
  execution: 'execution_panel',
  answer: 'answer',
  error: 'error',
  meta: 'meta',
  approval: 'approval',
  approvalButtons: 'approval_buttons',
  plan: 'plan',
  stop: 'turn_stop',
  notify: 'notify',
} as const

export const CARD_ACTIONS = {
  toolApproval: 'tool_approval',
  turnStop: 'turn_stop',
  humanInputCancel: 'human_input_cancel',
} as const

export const HUMAN_INPUT_CARD_FIELDS = {
  form: 'human_input_form',
  submit: 'human_input_submit',
} as const

const MILLISECONDS_PER_SECOND = 1_000

export type TurnCardStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'limited'
export type ToolCardStatus = 'running' | 'completed' | 'failed'
export type ApprovalCardOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ToolCardItem {
  readonly id: string
  readonly name: string
  readonly detail?: string
  readonly status: ToolCardStatus
  readonly startedAt?: number
  readonly updatedAt?: number
}

export interface TurnCardUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly contextTokens: number
}

export interface TurnCard {
  readonly locale?: LarkLocale
  readonly status: TurnCardStatus
  readonly answer?: string
  readonly error?: string
  readonly tools: readonly ToolCardItem[]
  readonly startedAt: number
  readonly updatedAt: number
  readonly usage?: TurnCardUsage
  readonly contextWindow?: number
  readonly loadingImageKey?: string
  readonly stopRequestId?: string
  readonly reasoning?: string
  readonly todos?: readonly TurnCardTodo[]
}

export interface TurnCardTodo {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

export interface ApprovalCard {
  readonly locale?: LarkLocale
  readonly requestId: string
  readonly toolName: string
  readonly reason?: string
}

export type HumanInputCardOutcome = 'answered' | 'cancelled' | 'timed-out' | 'unavailable'

export interface HumanInputCard {
  readonly locale?: LarkLocale
  readonly requestId: string
  readonly request: HumanInputRequest
}

const TOOL_STATUS: Record<ToolCardStatus, { mark: string; color: string; icon: string }> = {
  running: { mark: '⏳', color: 'blue', icon: 'loading_outlined' },
  completed: { mark: '✓', color: 'green', icon: 'done_outlined' },
  failed: { mark: '✕', color: 'red', icon: 'close_outlined' },
}

function attentionHeader(
  status: TurnCardStatus,
  locale: LarkLocale,
): { title: string; template: string } | undefined {
  const copy = localeCopy(locale).card
  const headers: Partial<Record<TurnCardStatus, { title: string; template: string }>> = {
    failed: { title: copy.failed, template: 'red' },
    blocked: { title: copy.blocked, template: 'orange' },
    cancelled: { title: copy.cancelled, template: 'grey' },
    limited: { title: copy.limited, template: 'orange' },
  }
  return headers[status]
}

function truncateRunes(value: string, limit: number): string {
  const runes = [...value.trim()]
  return runes.length <= limit ? runes.join('') : `${runes.slice(0, limit).join('')}…`
}

function truncateReasoning(value: string): string {
  const lines = value.trim().split('\n')
  const visible = lines.slice(-CARD_LIMITS.maxReasoningLines).join('\n')
  const runes = [...visible]
  const content = runes.length <= CARD_LIMITS.maxReasoningRunes
    ? visible
    : runes.slice(-CARD_LIMITS.maxReasoningRunes).join('')
  return lines.length <= CARD_LIMITS.maxReasoningLines
    && runes.length <= CARD_LIMITS.maxReasoningRunes
    ? content
    : `…${content}`
}

function escapePlatformMarkup(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeMarkdown(value: string): string {
  return escapePlatformMarkup(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
}

function compactMarkdownHeadings(value: string): string {
  let fence: { marker: '`' | '~'; length: number } | undefined
  return value.split('\n').map((line) => {
    const match = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line)
    const run = match?.[2]
    if (fence !== undefined) {
      if (run?.[0] === fence.marker && run.length >= fence.length && match?.[3]?.trim() === '') {
        fence = undefined
      }
      return line
    }
    if (run !== undefined) {
      fence = { marker: run[0] as '`' | '~', length: run.length }
      return line
    }
    const heading = /^(\s{0,3})#{1,6}\s+(.+?)\s*$/.exec(line)
    if (heading === null) return line
    const content = (heading[2] ?? '').replace(/\s+#+\s*$/, '')
    return `${heading[1] ?? ''}${content.startsWith('**') && content.endsWith('**') ? content : `**${content}**`}`
  }).join('\n')
}

function normalizedTools(tools: readonly ToolCardItem[]): ToolCardItem[] {
  return tools.slice(-CARD_LIMITS.maxVisibleTools).map((tool) => ({
    id: tool.id,
    name: truncateRunes(tool.name, CARD_LIMITS.maxToolNameRunes),
    detail: tool.detail === undefined
      ? undefined
      : truncateRunes(tool.detail, CARD_LIMITS.maxToolDetailRunes),
    status: tool.status,
    startedAt: tool.startedAt,
    updatedAt: tool.updatedAt,
  }))
}

function toolEmoji(name: string): string {
  const normalized = name.toLowerCase()
  if (/job|output/.test(normalized)) return '📤'
  if (/bash|shell|exec|command|terminal/.test(normalized)) return '⌨️'
  if (/read|view|inspect/.test(normalized)) return '📖'
  if (/write|create/.test(normalized)) return '📝'
  if (/edit|patch|replace/.test(normalized)) return '✏️'
  if (/search|find|grep|query/.test(normalized)) return '🔎'
  if (/browser|web|fetch|http/.test(normalized)) return '🌐'
  if (/agent|task|workflow/.test(normalized)) return '🧩'
  return '🛠️'
}

function toolDuration(tool: ToolCardItem, now: number): string | undefined {
  if (tool.startedAt === undefined) return undefined
  const end = tool.status === 'running' ? now : tool.updatedAt
  if (end === undefined) return undefined
  return `${(Math.max(0, end - tool.startedAt) / MILLISECONDS_PER_SECOND).toFixed(1)}s`
}

function cardSummary(card: TurnCard): string {
  const answer = card.answer === undefined
    ? undefined
    : compactMarkdownHeadings(card.answer).replaceAll('**', '').replace(/\s+/g, ' ').trim()
  const summary = answer === undefined || answer === ''
    ? statusText(card.status, card.locale ?? DEFAULT_CONFIG.locale)
    : answer
  return truncateRunes(summary, CARD_LIMITS.maxSummaryRunes)
}

function statusText(status: TurnCardStatus, locale: LarkLocale): string {
  return localeCopy(locale).card[status]
}

function markdownElement(
  elementId: string,
  content: string,
  textSize: string = CARD_STYLE.normalText,
): Record<string, unknown> {
  return {
    tag: CARD_STYLE.tagMarkdown,
    ...(elementId === '' ? {} : { element_id: elementId }),
    content,
    text_align: CARD_STYLE.alignLeft,
    text_size: textSize,
    margin: CARD_STYLE.noMargin,
  }
}

function plainTextElement(content: string, textColor?: string): Record<string, unknown> {
  return {
    tag: CARD_STYLE.tagDiv,
    text: {
      tag: CARD_STYLE.tagPlainText,
      content: escapePlatformMarkup(content),
      text_size: CARD_STYLE.normalText,
      ...(textColor === undefined ? {} : { text_color: textColor }),
      text_align: CARD_STYLE.alignLeft,
    },
    margin: CARD_STYLE.noMargin,
  }
}

function loadingIcon(imageKey: string | undefined): Record<string, unknown> {
  return imageKey === undefined
    ? { tag: CARD_STYLE.tagStandardIcon, token: TOOL_STATUS.running.icon, color: TOOL_STATUS.running.color }
    : { tag: 'custom_icon', img_key: imageKey }
}

function turnStatusIcon(card: TurnCard): Record<string, unknown> {
  if (card.status === 'running') return loadingIcon(card.loadingImageKey)
  const icon = {
    completed: { token: 'done_outlined', color: 'green' },
    failed: { token: 'close_outlined', color: 'red' },
    blocked: { token: 'warning_outlined', color: 'orange' },
    cancelled: { token: 'close_outlined', color: 'grey' },
    limited: { token: 'warning_outlined', color: 'orange' },
  }[card.status]
  return { tag: CARD_STYLE.tagStandardIcon, ...icon }
}

function divider(): Record<string, unknown> {
  return { tag: CARD_STYLE.tagDivider }
}

function toolElements(card: TurnCard, tools: readonly ToolCardItem[]): Record<string, unknown>[] {
  const hidden = Math.max(0, card.tools.length - tools.length)
  const elements: Record<string, unknown>[] = []
  if (hidden > 0) {
    const copy = localeCopy(card.locale ?? DEFAULT_CONFIG.locale).card
    elements.push(markdownElement('', `<font color='grey'>${hidden} ${copy.earlierTools}</font>`, CARD_STYLE.metaText))
  }
  for (const tool of tools) {
    const style = TOOL_STATUS[tool.status]
    const duration = toolDuration(tool, card.updatedAt)
    const time = duration === undefined ? '' : ` <font color='grey'>· ${duration}</font>`
    const detailElement = tool.detail === undefined || tool.detail === ''
      ? undefined
      : markdownElement('', `<font color='grey'>${escapeMarkdown(tool.detail)}</font>`, CARD_STYLE.metaText)
    if (detailElement !== undefined) {
      detailElement.icon = tool.status === 'running'
        ? loadingIcon(card.loadingImageKey)
        : { tag: CARD_STYLE.tagStandardIcon, token: style.icon, color: style.color }
    }
    elements.push({
      tag: CARD_STYLE.tagPanel,
      direction: CARD_STYLE.direction,
      vertical_spacing: CARD_STYLE.panelSpacing,
      padding: CARD_STYLE.panelPadding,
      background_color: CARD_STYLE.panelBackground,
      expanded: tool.status === 'running',
      header: {
        title: {
          tag: CARD_STYLE.tagMarkdown,
          content: `<font color='${style.color}'>${style.mark}</font> ${toolEmoji(tool.name)} **${escapeMarkdown(tool.name)}**${time}`,
        },
        background_color: CARD_STYLE.panelBackground,
        vertical_align: CARD_STYLE.alignCenter,
        padding: CARD_STYLE.panelHeaderPadding,
        icon: {
          tag: CARD_STYLE.tagStandardIcon,
          token: CARD_STYLE.panelChevron,
          size: CARD_STYLE.panelChevronSize,
        },
        icon_position: CARD_STYLE.alignRight,
        icon_expanded_angle: CARD_STYLE.panelExpandedAngle,
      },
      border: { color: CARD_STYLE.panelBorder, corner_radius: CARD_STYLE.panelRadius },
      elements: detailElement === undefined ? [] : [detailElement],
    })
  }
  return elements
}

function reasoningElement(card: TurnCard): Record<string, unknown> | undefined {
  const locale = card.locale ?? DEFAULT_CONFIG.locale
  const content = card.reasoning === undefined || card.reasoning === ''
    ? card.status === 'running' ? statusText(card.status, locale) : undefined
    : card.reasoning
  if (content === undefined) return undefined
  return {
    tag: CARD_STYLE.tagDiv,
    text: {
      tag: CARD_STYLE.tagPlainText,
      content: escapePlatformMarkup(content),
      text_size: CARD_STYLE.normalText,
      text_color: 'grey',
      text_align: CARD_STYLE.alignLeft,
      lines: CARD_LIMITS.maxReasoningLines,
    },
    icon: turnStatusIcon(card),
    margin: CARD_STYLE.noMargin,
  }
}

function executionPanel(card: TurnCard, tools: readonly ToolCardItem[]): Record<string, unknown> | undefined {
  if (tools.length === 0 && (card.reasoning === undefined || card.reasoning === '') && card.status !== 'running') {
    return undefined
  }
  const elements = toolElements(card, tools)
  const reasoning = reasoningElement(card)
  if (reasoning !== undefined) elements.unshift(reasoning)
  return {
    tag: CARD_STYLE.tagPanel,
    element_id: CARD_ELEMENT.execution,
    direction: CARD_STYLE.direction,
    vertical_spacing: CARD_STYLE.panelSpacing,
    padding: CARD_STYLE.panelPadding,
    background_color: CARD_STYLE.panelBackground,
    expanded: card.status === 'running',
    header: {
      title: {
        tag: CARD_STYLE.tagMarkdown,
        content: localeCopy(card.locale ?? DEFAULT_CONFIG.locale).card.executionTitle,
      },
      background_color: CARD_STYLE.panelBackground,
      vertical_align: CARD_STYLE.alignCenter,
      padding: CARD_STYLE.panelHeaderPadding,
      icon: {
        tag: CARD_STYLE.tagStandardIcon,
        token: CARD_STYLE.panelChevron,
        size: CARD_STYLE.panelChevronSize,
      },
      icon_position: CARD_STYLE.alignRight,
      icon_expanded_angle: CARD_STYLE.panelExpandedAngle,
    },
    border: { color: CARD_STYLE.panelBorder, corner_radius: CARD_STYLE.panelRadius },
    elements,
  }
}

function todoElement(
  todos: readonly TurnCardTodo[],
  locale: LarkLocale,
): Record<string, unknown> | undefined {
  if (todos.length === 0) return undefined
  const visible = todos.slice(-CARD_LIMITS.maxVisibleTodos)
  const hidden = Math.max(0, todos.length - visible.length)
  const copy = localeCopy(locale).card
  const lines: string[] = [copy.planTitle]
  if (hidden > 0) lines.push(`<font color='grey'>${hidden} ${copy.earlierTodos}</font>`)
  const icons: Record<TurnCardTodo['status'], string> = {
    pending: '○',
    in_progress: '◉',
    completed: '✓',
  }
  for (const todo of visible) {
    lines.push(`${icons[todo.status]} ${escapeMarkdown(truncateRunes(todo.content, CARD_LIMITS.maxTodoRunes))}`)
  }
  return markdownElement(CARD_ELEMENT.plan, lines.join('\n'))
}

function footer(card: TurnCard): Record<string, unknown> {
  const elapsedMilliseconds = Math.max(0, card.updatedAt - card.startedAt)
  const locale = card.locale ?? DEFAULT_CONFIG.locale
  const copy = localeCopy(locale).card
  const elapsed = `${(elapsedMilliseconds / MILLISECONDS_PER_SECOND).toFixed(1)}${copy.seconds}`
  const summary = [statusText(card.status, locale), elapsed]
  if (card.contextWindow !== undefined) {
    const context = card.usage === undefined
      ? compactTokens(card.contextWindow)
      : `${compactTokens(card.usage.contextTokens)}/${compactTokens(card.contextWindow)} (${compactPercent(card.usage.contextTokens, card.contextWindow)})`
    summary.push(`${copy.context} ${context}`)
  }
  if (card.usage !== undefined) {
    const usage = [`${copy.inputTokens} ${compactTokens(card.usage.inputTokens)}`]
    const cacheableTokens = card.usage.inputTokens + card.usage.cacheReadTokens + card.usage.cacheWriteTokens
    if (cacheableTokens > 0) {
      usage.push(`${copy.cacheReadTokens} ${compactTokens(card.usage.cacheReadTokens)} (${compactPercent(card.usage.cacheReadTokens, cacheableTokens)})`)
    }
    if (card.usage.cacheWriteTokens > 0) usage.push(`${copy.cacheWriteTokens} ${compactTokens(card.usage.cacheWriteTokens)}`)
    usage.push(`${copy.outputTokens} ${compactTokens(card.usage.outputTokens)}`)
    if (card.usage.reasoningTokens > 0) usage.push(`${copy.reasoningTokens} ${compactTokens(card.usage.reasoningTokens)}`)
    summary.push(...usage)
  }
  return {
    tag: CARD_STYLE.tagColumnSet,
    element_id: CARD_ELEMENT.meta,
    flex_mode: CARD_STYLE.flexNone,
    columns: [{
      tag: CARD_STYLE.tagColumn,
      width: CARD_STYLE.widthWeighted,
      weight: 1,
      elements: [markdownElement('', `<font color='grey'>${summary.join(' · ')}</font>`, CARD_STYLE.metaText)],
    }],
  }
}

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  const [divisor, suffix] = tokens < 1_000_000 ? [1_000, 'K'] as const : [1_000_000, 'M'] as const
  return `${(tokens / divisor).toFixed(1).replace(/\.0$/, '')}${suffix}`
}

function compactPercent(value: number, total: number): string {
  return `${(value / total * 100).toFixed(1).replace(/\.0$/, '')}%`
}

function cardElements(card: TurnCard, tools: readonly ToolCardItem[]): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = []
  const panel = executionPanel(card, tools)
  if (panel !== undefined) elements.push(panel)
  const plan = todoElement(card.todos ?? [], card.locale ?? DEFAULT_CONFIG.locale)
  if (plan !== undefined) {
    if (elements.length > 0) elements.push(divider())
    elements.push(plan)
  }
  if (card.answer !== undefined && card.answer !== '') {
    if (elements.length > 0) elements.push(divider())
    elements.push(markdownElement(
      CARD_ELEMENT.answer,
      escapePlatformMarkup(compactMarkdownHeadings(card.answer)),
    ))
  }
  if (card.error !== undefined && card.error !== '') {
    if (elements.length > 0) elements.push(divider())
    elements.push(markdownElement(CARD_ELEMENT.error, `<font color='red'>${escapeMarkdown(card.error)}</font>`))
  }
  if (card.status === 'running' && card.stopRequestId !== undefined) {
    if (elements.length > 0) elements.push(divider())
    elements.push(stopElement(card.stopRequestId, card.locale ?? DEFAULT_CONFIG.locale))
  }
  if (elements.length > 0) elements.push(divider())
  elements.push(footer(card))
  return elements
}

function basePayload(summary: string, elements: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema: CARD_STYLE.schema,
    config: {
      update_multi: true,
      summary: { content: escapePlatformMarkup(truncateRunes(summary, CARD_LIMITS.maxSummaryRunes)) },
      style: {
        text_size: {
          normal_v2: {
            default: CARD_STYLE.defaultTextSize,
            pc: CARD_STYLE.defaultTextSize,
            mobile: CARD_STYLE.mobileTextSize,
          },
        },
      },
    },
    body: {
      direction: CARD_STYLE.direction,
      horizontal_spacing: CARD_STYLE.spacing,
      vertical_spacing: CARD_STYLE.spacing,
      horizontal_align: CARD_STYLE.alignLeft,
      vertical_align: CARD_STYLE.alignTop,
      padding: CARD_STYLE.padding,
      elements,
    },
  }
}

function buildPayload(card: TurnCard, tools: readonly ToolCardItem[]): Record<string, unknown> {
  const payload = basePayload(cardSummary(card), cardElements(card, tools))
  const header = attentionHeader(card.status, card.locale ?? DEFAULT_CONFIG.locale)
  if (header !== undefined) {
    payload.header = {
      title: { tag: CARD_STYLE.tagPlainText, content: header.title },
      template: header.template,
      padding: CARD_STYLE.padding,
    }
  }
  return payload
}

function approvalButton(
  label: string,
  type: string,
  requestId: string,
  decision: ApprovalCardOutcome,
): Record<string, unknown> {
  return {
    tag: CARD_STYLE.tagColumn,
    width: CARD_STYLE.widthWeighted,
    weight: 1,
    vertical_align: CARD_STYLE.alignCenter,
    elements: [{
      tag: CARD_STYLE.tagButton,
      text: { tag: CARD_STYLE.tagPlainText, content: label },
      type,
      width: CARD_STYLE.widthFill,
      size: CARD_STYLE.buttonMedium,
      behaviors: [{
        type: CARD_STYLE.behaviorCallback,
        value: {
          action: CARD_ACTIONS.toolApproval,
          request_id: requestId,
          decision,
        },
      }],
    }],
  }
}

function stopElement(requestId: string, locale: LarkLocale): Record<string, unknown> {
  return {
    tag: CARD_STYLE.tagColumnSet,
    element_id: CARD_ELEMENT.stop,
    flex_mode: CARD_STYLE.flexNone,
    columns: [{
      tag: CARD_STYLE.tagColumn,
      width: CARD_STYLE.widthWeighted,
      weight: 1,
      elements: [{
        tag: CARD_STYLE.tagButton,
        text: { tag: CARD_STYLE.tagPlainText, content: localeCopy(locale).card.stop },
        type: 'danger',
        width: CARD_STYLE.widthFill,
        size: CARD_STYLE.buttonMedium,
        behaviors: [{
          type: CARD_STYLE.behaviorCallback,
          value: { action: CARD_ACTIONS.turnStop, request_id: requestId },
        }],
      }],
    }],
  }
}

function approvalElements(card: ApprovalCard): Record<string, unknown>[] {
  const toolName = truncateRunes(card.toolName, CARD_LIMITS.maxToolNameRunes)
  const reason = card.reason === undefined ? undefined : truncateRunes(card.reason, CARD_LIMITS.maxApprovalReasonRunes)
  const copy = localeCopy(card.locale ?? DEFAULT_CONFIG.locale).card
  const lines = [
    `**${copy.approvalTitle}**`,
    `${copy.approvalTool}: ${escapeMarkdown(toolName)}`,
  ]
  if (reason !== undefined && reason !== '') {
    lines.push(`${copy.approvalReason}: ${escapeMarkdown(reason)}`)
  }
  lines.push(`<font color='grey'>${copy.approvalRule}</font>`)
  return [
    {
      tag: CARD_STYLE.tagColumnSet,
      element_id: CARD_ELEMENT.approval,
      flex_mode: CARD_STYLE.flexNone,
      columns: [{
        tag: CARD_STYLE.tagColumn,
        width: CARD_STYLE.widthWeighted,
        weight: 1,
        elements: [markdownElement('', lines.join('\n\n'))],
      }],
    },
    {
      tag: CARD_STYLE.tagColumnSet,
      element_id: CARD_ELEMENT.approvalButtons,
      flex_mode: CARD_STYLE.flexNone,
      horizontal_spacing: CARD_STYLE.panelSpacing,
      columns: [
        approvalButton(copy.allowOnce, CARD_STYLE.buttonPrimary, card.requestId, 'allowed-once'),
        approvalButton(copy.deny, CARD_STYLE.buttonDefault, card.requestId, 'rejected'),
      ],
    },
  ]
}

function approvalDecision(
  outcome: ApprovalCardOutcome,
  locale: LarkLocale,
): { title: string; template: string } {
  const copy = localeCopy(locale).card
  return {
    'allowed-once': { title: copy.approved, template: 'green' },
    rejected: { title: copy.rejected, template: 'red' },
    cancelled: { title: copy.approvalCancelled, template: 'grey' },
    unavailable: { title: copy.approvalUnavailable, template: 'red' },
  }[outcome]
}

export function renderApprovalCard(card: ApprovalCard): Record<string, unknown> {
  if (card.requestId.trim() === '' || card.toolName.trim() === '') {
    throw new TypeError('lark: approval card requires requestId and toolName')
  }
  const copy = localeCopy(card.locale ?? DEFAULT_CONFIG.locale).card
  const payload = basePayload(
    `${copy.approvalSummary}: ${card.toolName}`,
    approvalElements(card),
  )
  if (payloadBytes(payload) > CARD_LIMITS.maxBytes) {
    throw new RangeError('lark: approval card exceeds the plugin Card byte budget')
  }
  return payload
}

export function renderApprovalDecisionCard(
  outcome: ApprovalCardOutcome,
  toolName: string,
  locale: LarkLocale = DEFAULT_CONFIG.locale,
): Record<string, unknown> {
  const decided = approvalDecision(outcome, locale)
  const payload = basePayload(decided.title, [
    markdownElement(CARD_ELEMENT.approval, `**${escapeMarkdown(truncateRunes(toolName, CARD_LIMITS.maxToolNameRunes))}**`),
  ])
  payload.header = {
    title: { tag: CARD_STYLE.tagPlainText, content: decided.title },
    template: decided.template,
    padding: CARD_STYLE.padding,
  }
  return payload
}

export function humanInputSelectionFieldName(index: number): string {
  return `q${index}`
}

export function humanInputCustomFieldName(index: number): string {
  return `c${index}`
}

function humanInputQuestionElements(
  question: HumanInputQuestion,
  index: number,
  locale: LarkLocale,
): Record<string, unknown>[] {
  const copy = localeCopy(locale).card
  const heading = question.header === undefined
    ? `${index + 1}. ${question.question}`
    : `${index + 1}. ${question.header}\n${question.question}`
  // Questions and descriptions are model-authored, high-trust UI. Keep them
  // literal so they cannot create links, mentions, images, or other Markdown.
  const elements: Record<string, unknown>[] = [plainTextElement(heading)]
  if (question.options.length > 0) {
    const descriptions = question.options
      .filter((option) => option.description !== undefined)
      .map((option) => `${option.label} — ${option.description ?? ''}`)
    if (descriptions.length > 0) {
      elements.push(plainTextElement(descriptions.join('\n'), 'grey'))
    }
    elements.push({
      tag: question.multiSelect ? 'multi_select_static' : 'select_static',
      name: humanInputSelectionFieldName(index),
      required: false,
      type: 'default',
      width: CARD_STYLE.widthFill,
      placeholder: { tag: CARD_STYLE.tagPlainText, content: copy.humanInputSelectPlaceholder },
      options: question.options.map((option, optionIndex) => ({
        text: { tag: CARD_STYLE.tagPlainText, content: escapePlatformMarkup(option.label) },
        value: `q${index}_o${optionIndex}`,
      })),
    })
  }
  elements.push({
    tag: 'input',
    name: humanInputCustomFieldName(index),
    required: question.options.length === 0,
    width: CARD_STYLE.widthFill,
    input_type: 'multiline_text',
    rows: question.options.length === 0 ? 3 : 2,
    max_length: HUMAN_INPUT_LIMITS.maxCustomLength,
    placeholder: {
      tag: CARD_STYLE.tagPlainText,
      content: question.options.length === 0
        ? copy.humanInputTextPlaceholder
        : copy.humanInputCustomPlaceholder,
    },
  })
  return elements
}

function humanInputForm(card: HumanInputCard, locale: LarkLocale): Record<string, unknown> {
  const copy = localeCopy(locale).card
  const elements: Record<string, unknown>[] = [
    markdownElement('', `<font color='grey'>${escapeMarkdown(copy.humanInputSafety)}</font>`, CARD_STYLE.metaText),
  ]
  for (const [index, question] of card.request.questions.entries()) {
    elements.push(divider())
    elements.push(...humanInputQuestionElements(question, index, locale))
  }
  elements.push({
    tag: CARD_STYLE.tagButton,
    name: HUMAN_INPUT_CARD_FIELDS.submit,
    text: { tag: CARD_STYLE.tagPlainText, content: copy.humanInputSubmit },
    type: 'primary_filled',
    width: CARD_STYLE.widthFill,
    size: CARD_STYLE.buttonMedium,
    form_action_type: 'submit',
  })
  return {
    tag: 'form',
    name: HUMAN_INPUT_CARD_FIELDS.form,
    direction: CARD_STYLE.direction,
    vertical_spacing: CARD_STYLE.panelSpacing,
    elements,
  }
}

function humanInputCancelButton(requestId: string, locale: LarkLocale): Record<string, unknown> {
  const copy = localeCopy(locale).card
  return {
    tag: CARD_STYLE.tagButton,
    text: { tag: CARD_STYLE.tagPlainText, content: copy.humanInputCancel },
    type: CARD_STYLE.buttonDefault,
    width: CARD_STYLE.widthFill,
    size: CARD_STYLE.buttonMedium,
    behaviors: [{
      type: CARD_STYLE.behaviorCallback,
      value: { action: CARD_ACTIONS.humanInputCancel, request_id: requestId },
    }],
  }
}

export function renderHumanInputCard(card: HumanInputCard): Record<string, unknown> {
  if (card.requestId.trim() === '' || card.request.questions.length === 0) {
    throw new TypeError('lark: human-input card requires a request id and questions')
  }
  const locale = card.locale ?? DEFAULT_CONFIG.locale
  const copy = localeCopy(locale).card
  const payload = basePayload(copy.humanInputSummary, [
    humanInputForm(card, locale),
    humanInputCancelButton(card.requestId, locale),
  ])
  payload.header = {
    title: { tag: CARD_STYLE.tagPlainText, content: copy.humanInputTitle },
    template: 'blue',
    padding: CARD_STYLE.padding,
  }
  if (payloadBytes(payload) > CARD_LIMITS.maxBytes) {
    throw new RangeError('lark: human-input card exceeds the plugin Card byte budget')
  }
  return payload
}

export function renderHumanInputTerminalCard(
  outcome: HumanInputCardOutcome,
  locale: LarkLocale = DEFAULT_CONFIG.locale,
): Record<string, unknown> {
  const copy = localeCopy(locale).card
  const decided = {
    answered: { title: copy.humanInputSubmitted, template: 'green' },
    cancelled: { title: copy.humanInputCancelled, template: 'grey' },
    'timed-out': { title: copy.humanInputTimedOut, template: 'orange' },
    unavailable: { title: copy.humanInputUnavailable, template: 'red' },
  }[outcome]
  const payload = basePayload(decided.title, [
    markdownElement('', `**${escapeMarkdown(decided.title)}**`),
  ])
  payload.header = {
    title: { tag: CARD_STYLE.tagPlainText, content: decided.title },
    template: decided.template,
    padding: CARD_STYLE.padding,
  }
  return payload
}

function payloadBytes(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

export interface RenderedTurnCard {
  readonly payload: Record<string, unknown>
  readonly answerTruncated: boolean
}

function fitAnswer(card: TurnCard, tools: readonly ToolCardItem[]): RenderedTurnCard {
  const answer = [...(card.answer ?? '')]
  let low = 0
  let high = answer.length
  let fittedRunes = 0
  let fitted = buildPayload({ ...card, answer: '' }, tools)
  if (payloadBytes(fitted) > CARD_LIMITS.maxBytes) {
    throw new RangeError('lark: card chrome exceeds the plugin Card byte budget')
  }
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2)
    const suffix = middle < answer.length ? '…' : ''
    const candidate = buildPayload({ ...card, answer: `${answer.slice(0, middle).join('')}${suffix}` }, tools)
    if (payloadBytes(candidate) <= CARD_LIMITS.maxBytes) {
      fitted = candidate
      fittedRunes = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return {
    payload: fitted,
    answerTruncated: fittedRunes < answer.length,
  }
}

export function renderTurnCardWithMeta(input: TurnCard): RenderedTurnCard {
  const answerRunes = input.answer === undefined ? undefined : [...input.answer.trim()]
  const normalizedAnswer = input.answer === undefined
    ? undefined
    : truncateRunes(input.answer, CARD_LIMITS.maxAnswerRunes)
  const card: TurnCard = {
    ...input,
    answer: normalizedAnswer,
    error: input.error === undefined ? undefined : truncateRunes(input.error, CARD_LIMITS.maxErrorRunes),
    reasoning: input.reasoning === undefined
      ? undefined
      : truncateReasoning(input.reasoning),
  }
  const tools = normalizedTools(card.tools)
  const payload = buildPayload(card, tools)
  const answerTruncated = answerRunes !== undefined && answerRunes.length > CARD_LIMITS.maxAnswerRunes
  if (payloadBytes(payload) <= CARD_LIMITS.maxBytes) return { payload, answerTruncated }
  const fitted = fitAnswer(card, tools)
  return {
    payload: fitted.payload,
    answerTruncated: answerTruncated || fitted.answerTruncated,
  }
}

export function renderTurnCard(input: TurnCard): Record<string, unknown> {
  return renderTurnCardWithMeta(input).payload
}

export interface NotifyCard {
  readonly locale?: LarkLocale
  readonly kind: 'completion' | 'attention'
  readonly summary: string
  readonly mentionMarkup?: string
}

export function renderNotifyCard(card: NotifyCard): Record<string, unknown> {
  const locale = card.locale ?? DEFAULT_CONFIG.locale
  const copy = localeCopy(locale).card
  const title = card.kind === 'attention' ? copy.notifyAttentionTitle : copy.notifyCompletionTitle
  const body = card.mentionMarkup === undefined || card.mentionMarkup === ''
    ? escapeMarkdown(truncateRunes(card.summary, CARD_LIMITS.maxAnswerRunes))
    : `${card.mentionMarkup} ${escapeMarkdown(truncateRunes(card.summary, CARD_LIMITS.maxAnswerRunes))}`
  const payload = basePayload(title, [
    markdownElement(CARD_ELEMENT.notify, `**${escapeMarkdown(title)}**\n${body}`),
  ])
  payload.header = {
    title: { tag: CARD_STYLE.tagPlainText, content: title },
    template: card.kind === 'attention' ? 'orange' : 'blue',
    padding: CARD_STYLE.padding,
  }
  if (payloadBytes(payload) > CARD_LIMITS.maxBytes) {
    throw new RangeError('lark: notify card exceeds the plugin Card byte budget')
  }
  return payload
}
