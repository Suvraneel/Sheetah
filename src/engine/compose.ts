import { quoteIdent, quoteLiteral } from './db'

/**
 * Point-and-click actions (sort, filter, add column) don't mutate data: they compose plain,
 * readable SQL around the user's last query. The composed SQL is shown in the editor so
 * people can learn from it and keep editing.
 */
export interface Filter {
  column: string
  op: 'contains' | 'equals' | 'is_null' | 'not_null' | 'gt' | 'lt'
  value?: string
  numeric?: boolean
}

export interface Ops {
  sort?: { column: string; dir: 'asc' | 'desc' }
  filters: Filter[]
  computed: { name: string; expr: string }[]
}

export const emptyOps = (): Ops => ({ filters: [], computed: [] })
export const hasOps = (o: Ops) => !!o.sort || o.filters.length > 0 || o.computed.length > 0

function filterSql(f: Filter): string {
  const c = quoteIdent(f.column)
  switch (f.op) {
    case 'contains':
      return `${c}::VARCHAR ILIKE ${quoteLiteral(`%${f.value ?? ''}%`)}`
    case 'equals':
      return f.value === undefined ? `${c} IS NULL` : f.numeric && f.value !== '' && !isNaN(Number(f.value)) ? `${c} = ${Number(f.value)}` : `${c}::VARCHAR = ${quoteLiteral(f.value)}`
    case 'is_null':
      return `${c} IS NULL`
    case 'not_null':
      return `${c} IS NOT NULL`
    case 'gt':
      return `${c} > ${f.numeric ? Number(f.value) : quoteLiteral(f.value ?? '')}`
    case 'lt':
      return `${c} < ${f.numeric ? Number(f.value) : quoteLiteral(f.value ?? '')}`
  }
}

const indent = (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n')

export function compose(base: string, ops: Ops): string {
  const core = base.trim().replace(/;+\s*$/, '')
  if (!hasOps(ops)) return core
  let sql = core
  if (ops.computed.length) {
    const extra = ops.computed.map((c) => `${c.expr} AS ${quoteIdent(c.name)}`).join(',\n  ')
    sql = `SELECT *,\n  ${extra}\nFROM (\n${indent(sql)}\n)`
  }
  if (ops.filters.length || ops.sort) {
    let outer = `SELECT *\nFROM (\n${indent(sql)}\n)`
    if (ops.filters.length) outer += `\nWHERE ${ops.filters.map(filterSql).join('\n  AND ')}`
    if (ops.sort) outer += `\nORDER BY ${quoteIdent(ops.sort.column)} ${ops.sort.dir.toUpperCase()} NULLS LAST`
    sql = outer
  }
  return sql
}

export function describeFilter(f: Filter): string {
  switch (f.op) {
    case 'contains':
      return `${f.column} contains “${f.value}”`
    case 'equals':
      return f.value === undefined ? `${f.column} is empty` : `${f.column} = ${f.value}`
    case 'is_null':
      return `${f.column} is empty`
    case 'not_null':
      return `${f.column} is not empty`
    case 'gt':
      return `${f.column} > ${f.value}`
    case 'lt':
      return `${f.column} < ${f.value}`
  }
}
