import { Inbox } from '@deepseek-ai/dsh-agent'
import { contentHasImage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

function messagesHaveModelVisibleImage(messages: readonly Message[]): boolean {
  for (const message of messages) {
    if (contentHasImage(message.content)) return true
  }
  return false
}

function unknownMayContainImage(
  value: unknown,
  seen: Set<object>,
  depth: number,
): boolean {
  if (depth > 64) return true
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  if (!Array.isArray(value) && (value as { readonly type?: unknown }).type === 'image') return true
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    if (unknownMayContainImage(nested, seen, depth + 1)) return true
  }
  return false
}

/** Conservative preflight for non-canonical Session doubles or mixed-version logs. */
export function eventLogMayContainImage(events: readonly unknown[]): boolean {
  return unknownMayContainImage(events, new Set(), 0)
}

/** Test the exact model-visible surface of one live Session for image content. */
export function sessionHasModelVisibleImage(session: Session): boolean {
  return messagesHaveModelVisibleImage(session.deriveMessages())
}

/**
 * Reconstruct and test the exact model-visible surface of one detached event log.
 * Invalid surface metadata or malformed derived messages are deliberately allowed
 * to throw so callers fail closed instead of treating corrupt history as text-only.
 */
export function eventLogHasModelVisibleImage(events: readonly SessionEvent[]): boolean {
  const surface = foldSurface(events)
  const messages: Message[] = []
  for (const seq of surface.nodes) {
    const message = deriveEventMessage(events[seq])
    if (message !== null) messages.push(message)
  }
  return messagesHaveModelVisibleImage(messages)
}

/**
 * Reconstruct the durable Inbox exactly as rc.6 resume does and decide whether
 * pending work still needs an image-capable route before an Agent is opened.
 */
export function eventLogRequiresImageRouteRecovery(
  events: readonly SessionEvent[],
  seedLength: number,
): boolean {
  if (!Number.isSafeInteger(seedLength) || seedLength < 0 || seedLength > events.length) {
    throw new TypeError('lark: persisted Session seed boundary is invalid')
  }
  const inbox = new Inbox({
    header: { seedLength },
    events,
  } as unknown as Session, {
    inserted: () => {},
    discarded: () => {},
    claimed: () => {},
  })
  if (!inbox.hasPending) return false
  const surfaceHasImage = eventLogMayContainImage(events)
    ? eventLogHasModelVisibleImage(events)
    : false
  return surfaceHasImage || [...inbox.nextStep, ...inbox.nextTurn]
    .some((message) => contentHasImage(message.content))
}
