import { parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export const HUMAN_INPUT_LIMITS = {
  maxQuestions: 3,
  maxQuestionIdRunes: 64,
  maxQuestionRunes: 500,
  maxHeaderRunes: 80,
  maxOptions: 20,
  maxOptionLabelRunes: 80,
  maxOptionDescriptionRunes: 200,
  maxCustomLength: 1_000,
  maxCustomBytes: 4_000,
  timeoutMs: 30 * 60 * 1_000,
} as const

export const ASK_USER_QUESTION_NAME = 'ask_user_question'
export const ASK_USER_QUESTION_DESCRIPTION = 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.'

const DISPLAY_CONTROL_PATTERN = /[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
const SINGLE_LINE_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

export interface HumanInputOption {
  readonly label: string
  readonly description?: string
}

export interface HumanInputQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options: readonly HumanInputOption[]
  readonly multiSelect: boolean
}

export interface HumanInputRequest {
  readonly questions: readonly HumanInputQuestion[]
}

export interface HumanInputAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export interface HumanInputAnswer {
  readonly answers: readonly HumanInputAnswerItem[]
}

function boundedDisplayString(
  value: unknown,
  name: string,
  limit: number,
  singleLine: boolean,
): string {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw new TypeError(`lark: ${name} must be well-formed text`)
  }
  if (value.trim() === ''
    || value.trim() !== value
    || [...value].length > limit
    || (singleLine ? SINGLE_LINE_CONTROL_PATTERN : DISPLAY_CONTROL_PATTERN).test(value)) {
    throw new RangeError(`lark: ${name} is empty, unsafe, or exceeds its display limit`)
  }
  return value
}

export function normalizeHumanInputRequest(value: unknown): HumanInputRequest {
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > HUMAN_INPUT_LIMITS.maxQuestions) {
    throw new RangeError('lark: ask_user_question requires a bounded non-empty question list')
  }
  const ids = new Set<string>()
  const questions = value.map((raw, questionIndex): HumanInputQuestion => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError(`lark: question ${questionIndex + 1} is invalid`)
    }
    const source = raw as {
      id?: unknown
      question?: unknown
      header?: unknown
      options?: unknown
      multi_select?: unknown
    }
    const id = boundedDisplayString(
      source.id,
      `question ${questionIndex + 1} id`,
      HUMAN_INPUT_LIMITS.maxQuestionIdRunes,
      true,
    )
    if (ids.has(id)) throw new TypeError('lark: question ids must be unique')
    ids.add(id)
    const question = boundedDisplayString(
      source.question,
      `question ${questionIndex + 1}`,
      HUMAN_INPUT_LIMITS.maxQuestionRunes,
      false,
    )
    const header = source.header === undefined
      ? undefined
      : boundedDisplayString(
          source.header,
          `question ${questionIndex + 1} header`,
          HUMAN_INPUT_LIMITS.maxHeaderRunes,
          true,
        )
    if (source.options !== undefined && !Array.isArray(source.options)) {
      throw new TypeError(`lark: question ${questionIndex + 1} options are invalid`)
    }
    const rawOptions = source.options ?? []
    if (rawOptions.length > HUMAN_INPUT_LIMITS.maxOptions
      || (rawOptions.length > 0 && rawOptions.length < 2)) {
      throw new RangeError(`lark: question ${questionIndex + 1} has an invalid option count`)
    }
    const labels = new Set<string>()
    const options = rawOptions.map((rawOption, optionIndex): HumanInputOption => {
      if (rawOption === null || typeof rawOption !== 'object' || Array.isArray(rawOption)) {
        throw new TypeError(`lark: question ${questionIndex + 1} option ${optionIndex + 1} is invalid`)
      }
      const option = rawOption as { label?: unknown; description?: unknown }
      const label = boundedDisplayString(
        option.label,
        `question ${questionIndex + 1} option ${optionIndex + 1} label`,
        HUMAN_INPUT_LIMITS.maxOptionLabelRunes,
        true,
      )
      if (labels.has(label)) throw new TypeError('lark: option labels must be unique within a question')
      labels.add(label)
      const description = option.description === undefined
        ? undefined
        : boundedDisplayString(
            option.description,
            `question ${questionIndex + 1} option ${optionIndex + 1} description`,
            HUMAN_INPUT_LIMITS.maxOptionDescriptionRunes,
            true,
          )
      return Object.freeze({ label, ...(description === undefined ? {} : { description }) })
    })
    if (source.multi_select !== undefined && typeof source.multi_select !== 'boolean') {
      throw new TypeError(`lark: question ${questionIndex + 1} multi_select is invalid`)
    }
    const multiSelect = source.multi_select === true
    if (multiSelect && options.length === 0) {
      throw new TypeError('lark: free-text questions cannot be multi-select')
    }
    return Object.freeze({
      id,
      question,
      ...(header === undefined ? {} : { header }),
      options: Object.freeze(options),
      multiSelect,
    })
  })
  return Object.freeze({ questions: Object.freeze(questions) })
}

export function validateHumanInputAnswer(
  request: HumanInputRequest,
  value: unknown,
  options: { readonly requireEveryAnswer?: boolean } = {},
): HumanInputAnswer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('lark: human-input answer is invalid')
  }
  const rawAnswers = (value as { answers?: unknown }).answers
  if (!Array.isArray(rawAnswers) || rawAnswers.length !== request.questions.length) {
    throw new TypeError('lark: human-input answer count changed')
  }
  const answers = rawAnswers.map((raw, index): HumanInputAnswerItem => {
    const question = request.questions[index]
    if (question === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError('lark: human-input answer order is invalid')
    }
    const answer = raw as { id?: unknown; selected?: unknown; custom?: unknown }
    if (answer.id !== question.id || !Array.isArray(answer.selected)) {
      throw new TypeError('lark: human-input answer identity is invalid')
    }
    if (answer.selected.some((item) => typeof item !== 'string')) {
      throw new TypeError('lark: human-input selections are invalid')
    }
    const selected = [...answer.selected] as string[]
    const unique = new Set(selected)
    const allowed = new Set(question.options.map((option) => option.label))
    if (unique.size !== selected.length
      || selected.some((label) => !allowed.has(label))
      || (!question.multiSelect && selected.length > 1)) {
      throw new TypeError('lark: human-input selections do not match the question')
    }
    let custom: string | undefined
    if (answer.custom !== undefined) {
      if (typeof answer.custom !== 'string'
        || !answer.custom.isWellFormed()
        || [...answer.custom].length > HUMAN_INPUT_LIMITS.maxCustomLength
        || Buffer.byteLength(answer.custom, 'utf8') > HUMAN_INPUT_LIMITS.maxCustomBytes
        || DISPLAY_CONTROL_PATTERN.test(answer.custom)) {
        throw new TypeError('lark: human-input custom answer is invalid')
      }
      if (answer.custom.trim() === '') throw new TypeError('lark: human-input custom answer is empty')
      custom = answer.custom
    }
    if (!question.multiSelect && custom !== undefined && selected.length > 0) {
      throw new TypeError('lark: a single-select custom answer cannot accompany a selection')
    }
    if (options.requireEveryAnswer === true && selected.length === 0 && custom === undefined) {
      throw new TypeError('lark: every human-input question requires an answer')
    }
    return Object.freeze({
      id: question.id,
      selected: Object.freeze(selected),
      ...(custom === undefined ? {} : { custom }),
    })
  })
  return Object.freeze({ answers: Object.freeze(answers) })
}

const OFFICIAL_ASK_USER_PARAMETER_SPEC = { questions: {
  type: 'array',
  required: true,
  description: 'Questions to ask the user before continuing.',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: {
        type: 'string',
        required: true,
        description: 'Stable id for this question; echoed in the answer.',
      },
      question: {
        type: 'string',
        required: true,
        description: 'The specific question to ask the user.',
      },
      header: {
        type: 'string',
        description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
      },
      options: {
        type: 'array',
        description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            label: {
              type: 'string',
              required: true,
              description: 'Short user-facing option label.',
            },
            description: {
              type: 'string',
              description: 'One sentence explaining the tradeoff or impact.',
            },
          },
        },
      },
      multi_select: {
        type: 'boolean',
        description: 'Whether the user may select more than one option. Defaults to false.',
      },
    },
  },
} } as const

const OFFICIAL_ASK_USER_OUTPUT_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: { answers: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        selected: { type: 'array', required: true, items: { type: 'string' } },
        custom: { type: 'string' },
      },
    },
  } },
} as const

const OFFICIAL_ASK_USER_PARAMETERS = parameterSchemaSpecToJsonSchema(
  OFFICIAL_ASK_USER_PARAMETER_SPEC,
)
const OFFICIAL_ASK_USER_OUTPUT_SCHEMA = valueSchemaSpecToJsonSchema(
  OFFICIAL_ASK_USER_OUTPUT_SPEC,
)

export function isCompatibleAskUserQuestionDefinition(
  definition: ToolDefinition | undefined,
): definition is ToolDefinition {
  if (definition === undefined
    || definition.name !== ASK_USER_QUESTION_NAME
    || definition.description !== ASK_USER_QUESTION_DESCRIPTION
    || definition.timeoutMs !== undefined
    || definition.isConcurrencySafe !== undefined) return false
  try {
    return JSON.stringify(definition.parameters) === JSON.stringify(OFFICIAL_ASK_USER_PARAMETERS)
      && JSON.stringify(definition.output.schema) === JSON.stringify(OFFICIAL_ASK_USER_OUTPUT_SCHEMA)
  } catch {
    return false
  }
}
