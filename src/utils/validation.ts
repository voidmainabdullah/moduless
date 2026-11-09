import type { CrmRecord, Field, Module } from '#/types'
import { buildFieldSchema, isEmpty } from './fieldTypes'
import { matchesFilter } from './records'

export function isFieldVisible(m: Module, field: Field, data: Record<string, unknown>): boolean {
  const c = field.condition
  if (!c || !c.fieldId) return true
  const tmp = { id: 'tmp', data } as unknown as CrmRecord
  return matchesFilter(m, tmp, { id: 'c', fieldId: c.fieldId, op: c.op, value: c.value })
}

const NON_EDITABLE = new Set(['formula', 'autoId'])

export function validateRecordData(
  m: Module,
  data: Record<string, unknown>,
  opts: { existing?: CrmRecord[]; selfId?: string; fields?: Field[] } = {},
): Record<string, string> {
  const errors: Record<string, string> = {}
  const fields = opts.fields ?? m.fields
  for (const f of fields) {
    if (NON_EDITABLE.has(f.type)) continue
    if (!isFieldVisible(m, f, data)) continue
    const v = data[f.id]
    const res = buildFieldSchema(f).safeParse(v)
    if (!res.success) {
      errors[f.id] = res.error.issues[0]?.message ?? 'Invalid value'
      continue
    }
    if (f.unique && !isEmpty(v) && opts.existing) {
      const dup = opts.existing.some(
        (r) => r.moduleId === m.id && r.id !== opts.selfId && !r.deletedAt && String(r.data[f.id] ?? '').toLowerCase() === String(v).toLowerCase(),
      )
      if (dup) errors[f.id] = `${f.label} must be unique — this value is already used`
    }
  }
  return errors
}
