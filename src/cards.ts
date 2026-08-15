import { DEFAULT_CONFIG } from './config.ts'
import { localeCopy } from './locale.ts'
import type { LarkLocale } from './locale.ts'

export const CARD_LIMITS = {
  maxBytes: 28 * 1024,
  maxSummaryRunes: 100,
  maxAnswerRunes: 6_000,
  maxVisibleTools: 12,
  maxToolNameRunes: 80,
  maxToolDetailRunes: 240,
  maxErrorRunes: 600,
  maxApprovalReasonRunes: 1_000,
  maxReasoningRunes: 2_000,
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
  mobileTextSize: 'heading',
  direction: 'vertical',
  alignLeft: 'left',
  alignTop: 'top',
  alignCenter: 'center',
  alignRight: 'right',
  widthWeighted: 'weighted',
  flexNone: 'none',
  noMargin: '0px 0px 0px 0px',
  tagMarkdown: 'markdown',
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
  approvalBackground: 'orange-50',
} as const

const CARD_ELEMENT = {
  execution: 'execution_panel',
  answer: 'answer',
  error: 'error',
  meta: 'meta',
  approval: 'approval',
  approvalButtons: 'approval_buttons',
  plan: 'plan',
} as const

const CARD_ACTION = {
  toolApproval: 'tool_approval',
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
}

export interface TurnCardUsage {
  readonly inputTokens: number
  readonly outputTokens: number
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

const TOOL_STATUS: Record<ToolCardStatus, { icon: string; color: string }> = {
  running: { icon: '⏳', color: 'blue' },
  completed: { icon: '✅', color: 'green' },
  failed: { icon: '❌', color: 'red' },
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

function normalizedTools(tools: readonly ToolCardItem[]): ToolCardItem[] {
  return tools.slice(-CARD_LIMITS.maxVisibleTools).map((tool) => ({
    id: tool.id,
    name: truncateRunes(tool.name, CARD_LIMITS.maxToolNameRunes),
    detail: tool.detail === undefined
      ? undefined
      : truncateRunes(tool.detail, CARD_LIMITS.maxToolDetailRunes),
    status: tool.status,
  }))
}

function cardSummary(card: TurnCard): string {
  const answer = card.answer?.replace(/\s+/g, ' ').trim()
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
    element_id: elementId,
    content,
    text_align: CARD_STYLE.alignLeft,
    text_size: textSize,
    margin: CARD_STYLE.noMargin,
  }
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
    const detail = tool.detail === undefined || tool.detail === ''
      ? ''
      : `\n<font color='grey'>${escapeMarkdown(tool.detail)}</font>`
    elements.push(markdownElement(
      '',
      `${style.icon} <font color='${style.color}'>**${escapeMarkdown(tool.name)}**</font>${detail}`,
      CARD_STYLE.metaText,
    ))
  }
  return elements
}

function executionPanel(card: TurnCard, tools: readonly ToolCardItem[]): Record<string, unknown> | undefined {
  if (tools.length === 0 && (card.reasoning === undefined || card.reasoning === '')) return undefined
  const elements = toolElements(card, tools)
  if (card.reasoning !== undefined && card.reasoning !== '') {
    elements.unshift(markdownElement(
      '',
      escapePlatformMarkup(truncateRunes(card.reasoning, CARD_LIMITS.maxReasoningRunes)),
    ))
  }
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
  const elapsed = `${(elapsedMilliseconds / MILLISECONDS_PER_SECOND).toFixed(1)}s`
  const locale = card.locale ?? DEFAULT_CONFIG.locale
  const copy = localeCopy(locale).card
  const parts = [statusText(card.status, locale), elapsed]
  if (card.usage !== undefined) {
    parts.push(
      `${copy.inputTokens} ${card.usage.inputTokens} / ${copy.outputTokens} ${card.usage.outputTokens} ${copy.tokenUnit}`,
    )
  }
  return {
    tag: CARD_STYLE.tagColumnSet,
    element_id: CARD_ELEMENT.meta,
    flex_mode: CARD_STYLE.flexNone,
    columns: [{
      tag: CARD_STYLE.tagColumn,
      width: CARD_STYLE.widthWeighted,
      weight: 1,
      elements: [markdownElement('', `<font color='grey'>${parts.join(' · ')}</font>`, CARD_STYLE.metaText)],
    }],
  }
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
    elements.push(markdownElement(CARD_ELEMENT.answer, escapePlatformMarkup(card.answer)))
  }
  if (card.error !== undefined && card.error !== '') {
    if (elements.length > 0) elements.push(divider())
    elements.push(markdownElement(CARD_ELEMENT.error, `<font color='red'>${escapeMarkdown(card.error)}</font>`))
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
          action: CARD_ACTION.toolApproval,
          request_id: requestId,
          decision,
        },
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
      background_color: CARD_STYLE.approvalBackground,
      padding: CARD_STYLE.panelPadding,
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
    throw new RangeError('lark: approval card exceeds the platform byte limit')
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

function payloadBytes(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

function fitAnswer(card: TurnCard, tools: readonly ToolCardItem[]): Record<string, unknown> {
  const answer = [...(card.answer ?? '')]
  let low = 0
  let high = answer.length
  let fitted = buildPayload({ ...card, answer: '' }, tools)
  if (payloadBytes(fitted) > CARD_LIMITS.maxBytes) {
    throw new RangeError('lark: card chrome exceeds the platform byte limit')
  }
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2)
    const suffix = middle < answer.length ? '…' : ''
    const candidate = buildPayload({ ...card, answer: `${answer.slice(0, middle).join('')}${suffix}` }, tools)
    if (payloadBytes(candidate) <= CARD_LIMITS.maxBytes) {
      fitted = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return fitted
}

export function renderTurnCard(input: TurnCard): Record<string, unknown> {
  const card: TurnCard = {
    ...input,
    answer: input.answer === undefined ? undefined : truncateRunes(input.answer, CARD_LIMITS.maxAnswerRunes),
    error: input.error === undefined ? undefined : truncateRunes(input.error, CARD_LIMITS.maxErrorRunes),
    reasoning: input.reasoning === undefined
      ? undefined
      : truncateRunes(input.reasoning, CARD_LIMITS.maxReasoningRunes),
  }
  const tools = normalizedTools(card.tools)
  const payload = buildPayload(card, tools)
  return payloadBytes(payload) <= CARD_LIMITS.maxBytes ? payload : fitAnswer(card, tools)
}
