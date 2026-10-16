export interface Starter {
  label: string
  sql: string
  /** Show the result as a chart rather than a grid. */
  chart?: boolean
}

/** Starter queries for the built-in sample table (see createDemo in engine/ingest.ts). */
export const sampleStarters = (t: string): Starter[] => [
  {
    label: 'Revenue by city',
    sql: `SELECT city, round(sum(total)) AS revenue, count(*) AS orders\nFROM ${t}\nWHERE status = 'delivered'\nGROUP BY city\nORDER BY revenue DESC`,
  },
  {
    label: 'Monthly revenue',
    chart: true,
    // Complete months only: the sample's last month is partial and would read as a crash.
    sql: `SELECT date_trunc('month', ordered_at) AS month, round(sum(total)) AS revenue\nFROM ${t}\nWHERE ordered_at < (SELECT date_trunc('month', max(ordered_at)) FROM ${t})\nGROUP BY month\nORDER BY month`,
  },
  {
    label: 'Best sellers',
    sql: `SELECT product, sum(quantity) AS units, round(sum(total)) AS revenue\nFROM ${t}\nGROUP BY product\nORDER BY units DESC\nLIMIT 10`,
  },
  {
    label: 'Return rate by category',
    sql: `SELECT category,\n  round(100.0 * count(*) FILTER (WHERE status = 'returned') / count(*), 1) AS return_pct\nFROM ${t}\nGROUP BY category\nORDER BY return_pct DESC`,
  },
]
