import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CallId,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  eventLogHasModelVisibleImage,
  eventLogMayContainImage,
  eventLogRequiresImageRouteRecovery,
  messagesHaveModelVisibleImage,
  sessionHasModelVisibleImage,
} from '../src/session-media.ts'

const IMAGE_BLOCK: ImageBlock = Object.freeze({
  type: 'image',
  attachment: Object.freeze({
    attachmentId: `sha256:${'a'.repeat(64)}` as ImageBlock['attachment']['attachmentId'],
    mediaType: 'image/png',
    bytes: 68,
    width: 1,
    height: 1,
    name: 'pixel.png',
  }),
})

function textMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  })
}

function imageMessage() {
  return createUserMessage({
    content: [IMAGE_BLOCK],
    source: { kind: 'user' as const },
  })
}

test('already-derived messages are scanned without another Session derive', () => {
  const session = Session.create(SessionId('session-media-derived-messages'))
  session.append('turn/start', { turn: 0 })
  session.append('user/message', textMessage('text only'), { surfaceOp: 'append' })
  const derived = session.deriveMessages()
  let deriveCalls = 0
  const original = session.deriveMessages.bind(session)
  session.deriveMessages = ((...args: Parameters<Session['deriveMessages']>) => {
    deriveCalls += 1
    return original(...args)
  }) as Session['deriveMessages']

  assert.equal(messagesHaveModelVisibleImage(derived), false)
  assert.equal(deriveCalls, 0)
  session.append('user/message', imageMessage(), { surfaceOp: 'append' })
  assert.equal(messagesHaveModelVisibleImage(session.deriveMessages()), true)
  assert.equal(deriveCalls, 1)
  assert.equal(sessionHasModelVisibleImage(session), true)
  assert.equal(deriveCalls, 2)
})

test('live Session detection uses the current derived model surface', () => {
  const session = Session.create(SessionId('session-media-live'))
  session.append('turn/start', { turn: 0 })
  session.append('user/message', textMessage('text only'), { surfaceOp: 'append' })
  assert.equal(sessionHasModelVisibleImage(session), false)

  session.append('user/message', imageMessage(), { surfaceOp: 'append' })
  assert.equal(sessionHasModelVisibleImage(session), true)
})

test('detached event-log detection reconstructs the same model-visible surface', () => {
  const session = Session.create(SessionId('session-media-detached'))
  session.append('user/message', textMessage('before image'), { surfaceOp: 'append' })
  session.append('user/message', imageMessage(), { surfaceOp: 'append' })

  assert.equal(eventLogHasModelVisibleImage(session.events), true)
  assert.deepEqual(session.deriveMessages().map((message) => message.id), [
    session.events[0]?.data.id,
    session.events[1]?.data.id,
  ])
})

test('a compaction replacement removes a shadowed image from both exact surfaces', () => {
  const session = Session.create(SessionId('session-media-shadowed'))
  session.append('user/message', imageMessage(), { surfaceOp: 'append' })
  assert.equal(sessionHasModelVisibleImage(session), true)
  assert.equal(eventLogHasModelVisibleImage(session.events), true)

  session.append('user/message', textMessage('compacted replacement'), {
    surfaceOp: { op: 'replace', start: 0, end: 0 },
    sourceEventSeqs: [0],
  })

  assert.equal(sessionHasModelVisibleImage(session), false)
  assert.equal(eventLogHasModelVisibleImage(session.events), false)
  assert.equal(session.events[0]?.data.content[0]?.type, 'image')
})

test('an image in the surviving replacement is model-visible', () => {
  const session = Session.create(SessionId('session-media-replacement-image'))
  session.append('user/message', textMessage('original text'), { surfaceOp: 'append' })
  session.append('user/message', imageMessage(), {
    surfaceOp: { op: 'replace', start: 0, end: 0 },
    sourceEventSeqs: [0],
  })

  assert.equal(sessionHasModelVisibleImage(session), true)
  assert.equal(eventLogHasModelVisibleImage(session.events), true)
})

test('nested tool-result image content is detected recursively', () => {
  const session = Session.create(SessionId('session-media-tool-result'))
  const message = createToolResultMessage({
    callId: CallId('call-image'),
    content: [
      { type: 'text', text: 'tool result' },
      IMAGE_BLOCK,
    ],
    isError: false,
  })
  session.append('tool/result', {
    turn: 0,
    step: 0,
    message,
  }, { surfaceOp: 'append' })

  assert.equal(sessionHasModelVisibleImage(session), true)
  assert.equal(eventLogHasModelVisibleImage(session.events), true)
})

test('malformed detached surface metadata throws instead of returning text-only', () => {
  const malformed = [{
    type: 'user/message',
    seq: 0,
    time: 0,
    data: textMessage('missing surface marker'),
  }] as unknown as readonly SessionEvent[]

  assert.throws(
    () => eventLogHasModelVisibleImage(malformed),
    /requires a surfaceOp marker/u,
  )
})

test('malformed detached surface message throws instead of returning text-only', () => {
  const malformed = [{
    type: 'user/message',
    seq: 0,
    time: 0,
    surfaceOp: 'append',
    data: {
      ...textMessage('invalid content'),
      content: null,
    },
  }] as unknown as readonly SessionEvent[]

  assert.throws(() => eventLogHasModelVisibleImage(malformed))
})

test('conservative image preflight detects raw image-like data and suspicious cycles', () => {
  assert.equal(eventLogMayContainImage([{ type: 'user/message', data: textMessage('text') }]), false)
  assert.equal(eventLogMayContainImage([{ type: 'user/message', data: imageMessage() }]), true)
  const cyclic: unknown[] = []
  cyclic.push(cyclic)
  assert.equal(eventLogMayContainImage(cyclic), true)
})

test('durable image recovery ignores inherited Inbox state and recognizes child pending work', () => {
  const inherited = Session.create(SessionId('session-media-inherited-inbox'))
  inherited.append('agent/inbox/spliced', {
    target: 'next-step',
    start: 0,
    inserted: [imageMessage()],
  })

  assert.equal(eventLogRequiresImageRouteRecovery(inherited.events, 1), false)
  assert.equal(eventLogRequiresImageRouteRecovery(inherited.events, 0), true)

  const child = Session.create(SessionId('session-media-child-inbox'))
  child.append('agent/inbox/spliced', {
    target: 'next-step',
    start: 0,
    inserted: [textMessage('parent pending input is not inherited')],
  })
  child.append('agent/inbox/spliced', {
    target: 'next-step',
    start: 0,
    inserted: [imageMessage()],
  })

  assert.equal(eventLogRequiresImageRouteRecovery(child.events, 1), true)
})

test('durable image recovery rejects invalid Session seed boundaries', () => {
  const session = Session.create(SessionId('session-media-invalid-seed'))
  assert.throws(
    () => eventLogRequiresImageRouteRecovery(session.events, -1),
    /seed boundary is invalid/u,
  )
  assert.throws(
    () => eventLogRequiresImageRouteRecovery(session.events, 0.5),
    /seed boundary is invalid/u,
  )
  assert.throws(
    () => eventLogRequiresImageRouteRecovery(session.events, 1),
    /seed boundary is invalid/u,
  )
})
