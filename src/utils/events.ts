import type { CrmRecord } from '#/types'

export type RecordEventType = 'created' | 'updated' | 'deleted'

export interface RecordEvent {
  type: RecordEventType
  record: CrmRecord
  previous?: CrmRecord
  /** recursion depth for workflow-triggered writes */
  depth: number
}

type Listener = (e: RecordEvent) => void
const listeners = new Set<Listener>()

export function onRecordEvent(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitRecordEvent(e: RecordEvent) {
  listeners.forEach((fn) => {
    try {
      fn(e)
    } catch (err) {
      console.error('record event listener failed', err)
    }
  })
}
