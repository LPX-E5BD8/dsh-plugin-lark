import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply as applyAskUserQuestion } from '@deepseek-ai/dsh-tool-ask-user'
import {
  CARD_ACTIONS,
  CARD_LIMITS,
  HUMAN_INPUT_CARD_FIELDS,
  renderHumanInputCard,
  renderHumanInputTerminalCard,
} from '../src/cards.ts'
import {
  HUMAN_INPUT_LIMITS,
  isCompatibleAskUserQuestionDefinition,
  normalizeHumanInputRequest,
  validateHumanInputAnswer,
} from '../src/human-input.ts'
import { unwrapCardAction } from '../src/lark.ts'

function sampleRequest() {
  return normalizeHumanInputRequest([
    {
      id: 'mode',
      header: 'Choose mode',
      question: 'Which mode should be used?',
      options: [
        { label: 'Safe', description: 'Uses the conservative path.' },
        { label: 'Fast', description: 'Uses the faster path.' },
      ],
    },
    {
      id: 'features',
      question: 'Which features are required?',
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      multi_select: true,
    },
    { id: 'note', question: 'Add a short note.' },
  ])
}

test('human input normalizes a bounded immutable batch without rewriting identities', () => {
  const request = sampleRequest()
  assert.equal(request.questions.length, 3)
  assert.equal(request.questions[0]?.id, 'mode')
  assert.equal(request.questions[0]?.options[0]?.label, 'Safe')
  assert.equal(request.questions[1]?.multiSelect, true)
  assert.equal(Object.isFrozen(request), true)
  assert.equal(Object.isFrozen(request.questions), true)
  assert.equal(Object.isFrozen(request.questions[0]), true)
  assert.equal(Object.isFrozen(request.questions[0]?.options[0]), true)

  for (const invalid of [
    [],
    [{ id: ' spaced ', question: 'No rewrite.' }],
    [{ id: 'x', question: 'Q', options: [{ label: 'Only' }] }],
    [{ id: 'x', question: 'Q', options: [{ label: 'A' }, { label: 'A' }] }],
    [{ id: 'x', question: 'Q', multi_select: true }],
    [{ id: 'x', question: `bad\u0000question` }],
  ]) {
    assert.throws(() => normalizeHumanInputRequest(invalid))
  }
  assert.throws(() => normalizeHumanInputRequest(Array.from(
    { length: HUMAN_INPUT_LIMITS.maxQuestions + 1 },
    (_, index) => ({ id: `q${index}`, question: 'Question' }),
  )))
})

test('human input validates an atomic exact-order answer and preserves custom text', () => {
  const request = sampleRequest()
  const custom = '  retain user spacing  '
  const answer = validateHumanInputAnswer(request, {
    answers: [
      { id: 'mode', selected: ['Safe'] },
      { id: 'features', selected: ['A', 'C'], custom: 'extra' },
      { id: 'note', selected: [], custom },
    ],
  }, { requireEveryAnswer: true })
  assert.equal(answer.answers[2]?.custom, custom)
  assert.deepEqual(answer.answers[1]?.selected, ['A', 'C'])

  const invalidAnswers = [
    { answers: [] },
    { answers: [
      { id: 'mode', selected: ['Unknown'] },
      { id: 'features', selected: ['A'] },
      { id: 'note', selected: [], custom: 'ok' },
    ] },
    { answers: [
      { id: 'mode', selected: ['Safe', 'Fast'] },
      { id: 'features', selected: ['A'] },
      { id: 'note', selected: [], custom: 'ok' },
    ] },
    { answers: [
      { id: 'mode', selected: ['Safe'], custom: 'both' },
      { id: 'features', selected: ['A'] },
      { id: 'note', selected: [], custom: 'ok' },
    ] },
    { answers: [
      { id: 'mode', selected: [] },
      { id: 'features', selected: ['A'] },
      { id: 'note', selected: [], custom: 'ok' },
    ] },
  ]
  for (const invalid of invalidAnswers) {
    assert.throws(() => validateHumanInputAnswer(request, invalid, { requireEveryAnswer: true }))
  }
})

test('human input compatibility gate matches the exact rc.7 ask tool definition', () => {
  let definition: ToolDefinition | undefined
  applyAskUserQuestion({
    tools: { register(value: ToolDefinition) { definition = value } },
    userQuestions: { ask() { throw new Error('not called') } },
  } as unknown as Context)
  assert.equal(isCompatibleAskUserQuestionDefinition(definition), true)
  assert.equal(isCompatibleAskUserQuestionDefinition(
    definition === undefined ? undefined : { ...definition, description: 'different' },
  ), false)
  assert.equal(isCompatibleAskUserQuestionDefinition(
    definition === undefined ? undefined : { ...definition, timeoutMs: 1 },
  ), false)
  assert.equal(isCompatibleAskUserQuestionDefinition(
    definition === undefined ? undefined : { ...definition, isConcurrencySafe: () => true },
  ), false)
})

test('human input Card 2.0 uses one root form and removes all interaction in terminal states', () => {
  const request = sampleRequest()
  const requestId = 'request-token'
  const card = renderHumanInputCard({ requestId, request, locale: 'en-US' }) as {
    schema?: string
    body?: { elements?: Array<Record<string, unknown>> }
  }
  assert.equal(card.schema, '2.0')
  assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') <= CARD_LIMITS.maxBytes)
  const form = card.body?.elements?.find((element) => element.tag === 'form') as {
    name?: string
    elements?: Array<Record<string, unknown>>
  } | undefined
  assert.equal(form?.name, HUMAN_INPUT_CARD_FIELDS.form)
  const submit = form?.elements?.find((element) => element.name === HUMAN_INPUT_CARD_FIELDS.submit)
  assert.equal(submit?.form_action_type, 'submit')
  assert.equal('behaviors' in (submit ?? {}), false)
  const optionValues = form?.elements
    ?.flatMap((element) => Array.isArray(element.options) ? element.options : [])
    .map((option) => String((option as { value?: unknown }).value)) ?? []
  assert.equal(new Set(optionValues).size, optionValues.length)
  const cancel = card.body?.elements?.find((element) => (
    JSON.stringify(element).includes(CARD_ACTIONS.humanInputCancel)
  ))
  assert.ok(cancel !== undefined)

  for (const outcome of ['answered', 'cancelled', 'timed-out', 'unavailable'] as const) {
    const terminal = renderHumanInputTerminalCard(outcome, 'en-US')
    const raw = JSON.stringify(terminal)
    assert.equal(raw.includes('form'), false)
    assert.equal(raw.includes('button'), false)
    assert.equal(raw.includes(requestId), false)
    assert.ok(Buffer.byteLength(raw, 'utf8') <= CARD_LIMITS.maxBytes)
  }
})

test('human input rejects a semantically bounded batch when its final Card exceeds 28 KiB', () => {
  const request = normalizeHumanInputRequest(Array.from(
    { length: HUMAN_INPUT_LIMITS.maxQuestions },
    (_, questionIndex) => ({
      id: `q${questionIndex}`,
      question: `Question ${questionIndex} ${'问'.repeat(HUMAN_INPUT_LIMITS.maxQuestionRunes - 20)}`,
      options: Array.from({ length: HUMAN_INPUT_LIMITS.maxOptions }, (_, optionIndex) => ({
        label: `${questionIndex}-${optionIndex}-${'项'.repeat(HUMAN_INPUT_LIMITS.maxOptionLabelRunes - 8)}`,
        description: '述'.repeat(HUMAN_INPUT_LIMITS.maxOptionDescriptionRunes),
      })),
      multi_select: true,
    }),
  ))
  assert.throws(
    () => renderHumanInputCard({ requestId: 'bounded-but-large', request }),
    /byte budget/u,
  )
})

test('human input renders model-authored prompts and descriptions only as literal plain text', () => {
  const marker = '[x](https://e.invalid) <at>'
  const request = normalizeHumanInputRequest([{
    id: 'literal',
    header: marker,
    question: marker,
    options: [
      { label: marker, description: marker },
      { label: 'Safe', description: 'Literal choice.' },
    ],
  }])
  const card = renderHumanInputCard({ requestId: 'literal-request', request })
  const records: Array<Record<string, unknown>> = []
  const pending: unknown[] = [card]
  while (pending.length > 0) {
    const value = pending.pop()
    if (Array.isArray(value)) {
      pending.push(...value)
    } else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      records.push(record)
      pending.push(...Object.values(record))
    }
  }
  const markerRecords = records.filter(({ content }) => (
    typeof content === 'string' && content.includes('e.invalid')
  ))
  assert.ok(markerRecords.length >= 3)
  assert.ok(markerRecords.every(({ tag }) => tag === 'plain_text'))
  assert.equal(records.some(({ tag, content }) => (
    tag === 'markdown' && typeof content === 'string' && content.includes('e.invalid')
  )), false)
})

test('human input card actions preserve strict form fields from wrapped and flat callbacks', () => {
  const wrapped = unwrapCardAction({
    event: {
      operator: { open_id: 'user' },
      action: {
        tag: 'button',
        name: HUMAN_INPUT_CARD_FIELDS.submit,
        value: {},
        form_value: JSON.stringify({ q0: 'q0_o1', q1: ['q1_o0', 'q1_o2'], c2: 'note' }),
      },
      context: { open_chat_id: 'chat', open_message_id: 'message' },
    },
  })
  assert.equal(wrapped.tag, 'button')
  assert.equal(wrapped.name, HUMAN_INPUT_CARD_FIELDS.submit)
  assert.deepEqual(wrapped.formValue, { q0: 'q0_o1', q1: ['q1_o0', 'q1_o2'], c2: 'note' })

  const flat = unwrapCardAction({
    operator: { open_id: { invalid: true } },
    action: { tag: 'multi_select_static', options: 'a,b' },
    context: { open_chat_id: 'chat', open_message_id: 'message' },
  })
  assert.equal(flat.openId, '')
  assert.deepEqual(flat.options, ['a', 'b'])
})
