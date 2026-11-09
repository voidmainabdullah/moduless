import { addDays, format } from 'date-fns'
import type { CrmRecord, Field, Workflow, WorkflowAction } from '#/types'
import { nowIso, uid } from '#/utils/id'
import { onRecordEvent, type RecordEvent } from '#/utils/events'
import { displayValue, makeCtx, matchesFilter, recordTitle, safeDate, valueOf, type Ctx } from '#/utils/records'
import { parseImportValue } from '#/utils/csv'
import { isEmpty, isSingleRel } from '#/utils/fieldTypes'
import { toast } from '#/utils/toast'
import { useModuleStore } from '#/stores/moduleStore'
import { useRecordStore } from '#/stores/recordStore'
import { useWorkflowStore, useRunStore } from '#/stores/collections'
import { useUserStore } from '#/stores/userStore'
import { logActivity } from '#/stores/activityStore'
import { ensureTasksModule } from './moduleService'
import { handleFlowEvent } from './dataFlowEngine'

const MAX_DEPTH = 3

function ctxNow(): Ctx {
  return makeCtx(useModuleStore.getState().modules, useRecordStore.getState().records, useUserStore.getState().users)
}

function render(tpl: string, rec: CrmRecord, extra: { value?: unknown } = {}): string {
  const m = useModuleStore.getState().modules.find((x) => x.id === rec.moduleId)
  const ctx = ctxNow()
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_all, key: string) => {
    if (key === 'today') return format(new Date(), 'yyyy-MM-dd')
    if (key === 'now') return nowIso()
    if (key === 'id') return rec.id
    if (!m) return ''
    if (key === 'title') return recordTitle(m, rec, ctx)
    if (key === 'module') return m.name
    if (key === 'value') return extra.value === undefined ? '' : String(extra.value)
    const f = m.fields.find((x) => x.id === key || x.name === key)
    if (f) return displayValue(f, valueOf(m, rec, f, ctx), ctx)
    return ''
  })
}

function coerce(field: Field | undefined, raw: unknown, rec: CrmRecord): unknown {
  if (typeof raw !== 'string') return raw
  const text = render(raw, rec)
  if (!field) return text
  if (field.type === 'relationship' && raw.trim() === '{{id}}') return isSingleRel(field) ? rec.id : [rec.id]
  if (field.type === 'dropdown' || field.type === 'radio') {
    // allow raw option id as-is
    if (field.options?.some((o) => o.id === raw)) return raw
  }
  const parsed = parseImportValue(field, text, ctxNow(), useRecordStore.getState().records)
  if (parsed.error) throw new Error(parsed.error)
  return parsed.value ?? ''
}

function logRun(wf: Workflow, status: 'success' | 'skipped' | 'error', message: string, rec?: CrmRecord, key?: string) {
  useRunStore.getState().add({
    id: uid('run'),
    workspaceId: wf.workspaceId,
    workflowId: wf.id,
    workflowName: wf.name,
    recordId: rec?.id,
    moduleId: rec?.moduleId ?? wf.moduleId,
    status,
    message,
    at: nowIso(),
    key,
  })
}

function conditionsPass(wf: Workflow, rec: CrmRecord): boolean {
  const m = useModuleStore.getState().modules.find((x) => x.id === wf.moduleId)
  if (!m) return false
  const ctx = ctxNow()
  return wf.conditions.every((c) => matchesFilter(m, rec, { id: c.id, fieldId: c.fieldId, op: c.op, value: c.value }, ctx))
}

function runAction(a: WorkflowAction, rec: CrmRecord, depth: number, trigValue?: unknown): string {
  const ms = useModuleStore.getState()
  const m = ms.modules.find((x) => x.id === rec.moduleId)!
  const rs = useRecordStore.getState()
  const fresh = () => rs.records.find((r) => r.id === rec.id) ?? rec
  switch (a.type) {
    case 'update_record':
    case 'change_status': {
      const f = m.fields.find((x) => x.id === a.fieldId)
      if (!f) throw new Error('Field no longer exists')
      const value = coerce(f, a.value, rec)
      useRecordStore.getState().update(rec.id, { [f.id]: value }, { depth: depth + 1 })
      return `${a.type === 'change_status' ? 'Changed' : 'Updated'} ${f.label}`
    }
    case 'assign_user': {
      const f = m.fields.find((x) => x.id === a.fieldId)
      if (!f || !a.userId) throw new Error('Pick a user field and a user')
      useRecordStore.getState().update(rec.id, { [f.id]: a.userId }, { depth: depth + 1 })
      return `Assigned ${f.label}`
    }
    case 'add_tag': {
      const f = m.fields.find((x) => x.id === a.fieldId)
      if (!f) throw new Error('Tag field no longer exists')
      const tag = render(String(a.value ?? ''), rec).trim()
      if (!tag) throw new Error('Tag is empty')
      const cur = Array.isArray(fresh().data[f.id]) ? (fresh().data[f.id] as string[]) : []
      let toAdd = tag
      if (f.type === 'multiSelect' || f.type === 'checkboxes') {
        const o = f.options?.find((x) => x.label.toLowerCase() === tag.toLowerCase() || x.id === tag)
        if (!o) throw new Error(`"${tag}" is not an option`)
        toAdd = o.id
      }
      if (!cur.includes(toAdd)) useRecordStore.getState().update(rec.id, { [f.id]: [...cur, toAdd] }, { depth: depth + 1 })
      return `Added tag "${tag}"`
    }
    case 'create_record': {
      const target = ms.modules.find((x) => x.id === a.moduleId)
      if (!target) throw new Error('Target module no longer exists')
      const data: Record<string, unknown> = {}
      for (const [fid, tpl] of Object.entries(a.values ?? {})) {
        const f = target.fields.find((x) => x.id === fid)
        if (!f || isEmpty(tpl)) continue
        const v = coerce(f, tpl, rec)
        if (v !== undefined && v !== '') data[fid] = v
      }
      const res = useRecordStore.getState().create(target.id, data, { depth: depth + 1, validate: false })
      if (!res.record) throw new Error('Could not create record')
      return `Created ${target.name} record`
    }
    case 'create_task':
    case 'create_followup': {
      const tm = ensureTasksModule(rec.workspaceId)
      const days = a.days ?? (a.type === 'create_followup' ? 2 : 0)
      const title = render(a.title || (a.type === 'create_followup' ? 'Follow up: {{title}}' : 'Task for {{title}}'), rec, { value: trigValue })
      const assignee = a.userId === 'owner' || !a.userId ? (rec.createdBy ?? '') : a.userId
      useRecordStore.getState().create(
        tm.id,
        { title, status: 'to_do', priority: 'medium', due: format(addDays(new Date(), days), 'yyyy-MM-dd'), assignee, related: `${m.name}: ${recordTitle(m, rec, ctxNow())}`, notes: `Created by workflow` },
        { depth: depth + 1, validate: false },
      )
      return `Created task "${title}"`
    }
    case 'notify': {
      const msg = render(a.message || 'Workflow notification for {{title}}', rec, { value: trigValue })
      toast.info('Workflow', msg)
      logActivity({ workspaceId: rec.workspaceId, action: 'workflow_notification', entity: 'workflow', moduleId: rec.moduleId, recordId: rec.id, description: msg })
      return `Notified: ${msg}`
    }
  }
}

export function executeWorkflow(wf: Workflow, recordInput: CrmRecord, depth = 0, opts: { key?: string; trigValue?: unknown; force?: boolean } = {}): boolean {
  const rec = useRecordStore.getState().records.find((r) => r.id === recordInput.id) ?? recordInput
  if (depth >= MAX_DEPTH) {
    logRun(wf, 'error', 'Stopped: workflows triggered each other too many times (loop protection)', rec, opts.key)
    return false
  }
  if (!conditionsPass(wf, rec)) {
    logRun(wf, 'skipped', 'Conditions not met', rec, opts.key)
    return false
  }
  const done: string[] = []
  try {
    for (const a of wf.actions) done.push(runAction(a, rec, depth, opts.trigValue))
    const m = useModuleStore.getState().modules.find((x) => x.id === rec.moduleId)
    logRun(wf, 'success', `${done.join('; ') || 'No actions'} — on "${m ? recordTitle(m, rec) : rec.id}"`, rec, opts.key)
    logActivity({ workspaceId: wf.workspaceId, action: 'workflow_ran', entity: 'workflow', moduleId: rec.moduleId, recordId: rec.id, description: `Workflow "${wf.name}" ran (${done.length} action${done.length === 1 ? '' : 's'})` })
    return true
  } catch (e) {
    logRun(wf, 'error', `${done.length ? done.join('; ') + '; then failed: ' : ''}${e instanceof Error ? e.message : 'Unknown error'}`, rec, opts.key)
    return false
  }
}

function matches(wf: Workflow, e: RecordEvent): { ok: boolean; value?: unknown } {
  const t = wf.trigger
  switch (t.type) {
    case 'record_created':
      return { ok: e.type === 'created' }
    case 'record_updated':
      return { ok: e.type === 'updated' }
    case 'record_deleted':
      return { ok: e.type === 'deleted' }
    case 'field_changed':
    case 'status_changed': {
      if (e.type !== 'updated' || !t.fieldId || !e.previous) return { ok: false }
      const before = JSON.stringify(e.previous.data[t.fieldId] ?? '')
      const nv = e.record.data[t.fieldId]
      if (before === JSON.stringify(nv ?? '')) return { ok: false }
      if (!isEmpty(t.value) && String(nv) !== String(t.value)) return { ok: false }
      return { ok: true, value: nv }
    }
    default:
      return { ok: false }
  }
}

function handleEvent(e: RecordEvent) {
  const wfs = useWorkflowStore.getState().items.filter((w) => w.enabled && w.moduleId === e.record.moduleId && w.workspaceId === e.record.workspaceId)
  for (const wf of wfs) {
    const r = matches(wf, e)
    if (!r.ok) continue
    let value = r.value
    const m = useModuleStore.getState().modules.find((x) => x.id === wf.moduleId)
    const f = m?.fields.find((x) => x.id === wf.trigger.fieldId)
    if (f && value !== undefined) value = displayValue(f, value, ctxNow())
    executeWorkflow(wf, e.record, e.depth, { trigValue: value })
  }
  // module-to-module data flows share the same event bus and depth limit
  handleFlowEvent(e)
}

export function runDateTriggers() {
  const wfs = useWorkflowStore.getState().items.filter((w) => w.enabled && w.trigger.type === 'date_reached' && w.trigger.fieldId)
  if (!wfs.length) return
  const runs = useRunStore.getState().runs
  const fired = new Set(runs.map((r) => r.key).filter(Boolean))
  const today = format(new Date(), 'yyyy-MM-dd')
  const cutoff = format(addDays(new Date(), -7), 'yyyy-MM-dd')
  for (const wf of wfs) {
    const m = useModuleStore.getState().modules.find((x) => x.id === wf.moduleId)
    if (!m) continue
    const f = m.fields.find((x) => x.id === wf.trigger.fieldId)
    if (!f) continue
    const offset = wf.trigger.offsetDays ?? 0
    const recs = useRecordStore.getState().records.filter((r) => r.moduleId === m.id && !r.deletedAt && !r.archived)
    for (const r of recs) {
      const d = safeDate(r.data[f.id])
      if (!d) continue
      const target = format(addDays(d, offset), 'yyyy-MM-dd')
      if (target > today || target < cutoff) continue
      const key = `${wf.id}:${r.id}:${target}`
      if (fired.has(key)) continue
      fired.add(key)
      executeWorkflow(wf, r, 0, { key })
    }
  }
}

export function runWorkflowNow(wf: Workflow, recordIds?: string[]): { ran: number; total: number } {
  const all = useRecordStore.getState().records.filter((r) => r.moduleId === wf.moduleId && !r.deletedAt && !r.archived)
  const targets = recordIds ? all.filter((r) => recordIds.includes(r.id)) : all
  let ran = 0
  for (const r of targets) if (executeWorkflow(wf, r, 0)) ran++
  if (!targets.length) logRun(wf, 'skipped', 'No records to run on')
  return { ran, total: targets.length }
}

let started = false
export function startWorkflowEngine() {
  if (started || typeof window === 'undefined') return
  started = true
  onRecordEvent(handleEvent)
  setTimeout(runDateTriggers, 1500)
  window.setInterval(runDateTriggers, 60_000)
}
