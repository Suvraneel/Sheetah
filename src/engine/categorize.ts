/*
 * Categories from words: "SWIGGY or ZOMATO → Food", "UBER, OLA → Travel". What people do with a bank
 * statement's narrations (or any free-text column) before a pivot by category and month. The rules become
 * a readable CASE in an added column, so they're kept with a saved view and run on next month's file.
 */
import { quoteLiteral, sqlName } from './sql'

export interface CategoryRule {
  category: string
  /**
   * Words (any of them) that put a row in the category: matched where a word starts, case ignored ("ola" is
   * Ola and OLACABS, not COLA). A word starts after anything that isn't a letter, in any script: a digit, _ or -.
   */
  words: string[]
}

export interface Categorize {
  /** The text column the words are looked for in. */
  column: string
  rules: CategoryRule[]
  /** For rows no rule matches (empty when not given). */
  otherwise?: string
}

const clean = (rules: CategoryRule[]) =>
  rules
    .map((r) => ({ category: r.category.trim(), words: [...new Set(r.words.map((w) => w.trim()).filter(Boolean))] }))
    .filter((r) => r.category && r.words.length)

/** Rules that do something: a category, and at least one word. */
export const usableRules = clean

/** A word as a regular expression that matches it where a word starts (or anywhere, if it starts with a symbol). */
const wordPattern = (w: string) => `${/^\p{L}/u.test(w) ? '(?:^|[^\\pL\\pM])' : ''}${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`

/**
 * The rules as SQL: the first rule with one of its words in the text wins (so put the narrower rules
 * first), case ignored; anything else is `otherwise`, or empty.
 */
export function categorizeExpr(c: Categorize, ref: (name: string) => string = sqlName): string {
  const col = ref(c.column)
  const other = c.otherwise?.trim() ? quoteLiteral(c.otherwise.trim()) : 'NULL'
  const rules = clean(c.rules)
  if (!rules.length) return other
  const whens = rules.map((r) => `WHEN regexp_matches(${col}::VARCHAR, ${quoteLiteral(`(${r.words.map(wordPattern).join('|')})`)}, 'i') THEN ${quoteLiteral(r.category)}`)
  return `CASE ${whens.join(' ')} ELSE ${other} END`
}

/** Words that say nothing about what a payment was for: payment rails, banks, filler. */
const FILLER = new Set(
  `upi neft imps rtgs nach ach ecs pos cms mmt inb ib net txn trf transfer tfr payment paid pay to from by for the and of in
  cr dr ref no bank ltd pvt private limited india indian co inc llp com www http https ok id via mob mobile acct ac account
  wdl withdrawal deposit chq cheque clg branch
  purchase debit card visa mastercard autopay pymt pmt tst sq mkt web online recurring help pending
  hdfc icici sbi axis kotak yes yesb yesbank idfc indusind pnb bob canara union federal rbl paytm paytmqr pytm phonepe gpay googlepay
  ybl okicici okhdfcbank oksbi okaxis apl ibl axl srl sbin utib icic kkbk barb punb ubin cnrb idib ioba mahb ucba indb kotk ratn fdrl`
    .split(/\s+/)
    .filter(Boolean),
)

/**
 * A text column's words, one per row and word: UPI handles (…@okicici) and IFSC codes (HDFC0001234) taken
 * out first, then split where the rules see a word end (anything but a letter, in any script), so a word
 * offered is one a rule matches.
 */
function words(table: string, ref: string, where?: string): string {
  const text = `regexp_replace(regexp_replace(lower(${ref}::VARCHAR), '@[a-z0-9._-]+', ' ', 'g'), '\\b[a-z]{4}0[a-z0-9]{6}\\b', ' ', 'g')`
  return `SELECT rowid AS r, regexp_split_to_table(${text}, '[^\\pL\\pM]+') AS w FROM ${table}${where ? ` WHERE ${where}` : ''}`
}

/**
 * The commonest words of a text column (a narration's merchants and payees), by the rows they're in:
 * three letters or more, filler left out. `table` is read; `ref` is the column as SQL; `where` picks the
 * rows (those no category has taken yet, say).
 */
export function wordsSql(table: string, ref: string, limit = 24, where?: string): string {
  const filler = [...FILLER].map(quoteLiteral).join(', ')
  return `SELECT w AS word, count(DISTINCT r)::DOUBLE AS rows FROM (${words(table, ref, where)})
WHERE length(w) >= 3 AND w NOT IN (${filler}) AND NOT regexp_full_match(w, 'x+')
GROUP BY w ORDER BY rows DESC, w LIMIT ${limit}`
}

/** Which of the usual categories' words the column has anywhere (not only among its commonest words). */
export function knownWordsSql(table: string, ref: string): string {
  const known = Object.values(KNOWN).flat().map(quoteLiteral).join(', ')
  return `SELECT DISTINCT w AS word FROM (${words(table, ref)}) WHERE w IN (${known}) ORDER BY w`
}

/** Categories most statements need, from a word's usual meaning. A starting point: every rule is editable. */
const KNOWN: Record<string, string[]> = {
  // First: a charge names what it's for ("ATM CHGS", "SMS CHGS+GST"), and it's a charge, not that.
  'Charges and fees': ['charges', 'chrg', 'chgs', 'fee', 'fees', 'penalty', 'amc'],
  'Food and dining': ['swiggy', 'zomato', 'dominos', 'mcdonalds', 'starbucks', 'restaurant', 'cafe', 'eatsure', 'blinkit', 'zepto', 'bigbasket', 'dunzo', 'instamart', 'chipotle', 'doordash', 'grubhub', 'ubereats', 'dunkin', 'kroger', 'safeway', 'wholefds'],
  Shopping: ['amazon', 'flipkart', 'myntra', 'ajio', 'nykaa', 'meesho', 'tatacliq', 'decathlon', 'ikea', 'walmart', 'costco', 'ebay', 'etsy', 'bestbuy'],
  Travel: ['uber', 'ola', 'rapido', 'irctc', 'makemytrip', 'goibibo', 'indigo', 'vistara', 'airindia', 'redbus', 'cleartrip', 'fastag', 'lyft', 'airbnb', 'expedia', 'marriott', 'hilton'],
  'Bills and recharges': ['airtel', 'jio', 'vodafone', 'bsnl', 'tatasky', 'electricity', 'bescom', 'tneb', 'msedcl', 'billdesk', 'broadband', 'recharge', 'comcast', 'xfinity', 'verizon', 'tmobile'],
  'Cash withdrawals': ['atm', 'atw', 'nwd', 'cwdr'],
  Salary: ['salary', 'payroll'],
  'GST and taxes': ['gst', 'cbic', 'gstn', 'tds', 'cbdt', 'incometax', 'advtax'],
  Rent: ['rent'],
  Investments: ['zerodha', 'groww', 'mutual', 'sip', 'upstox', 'kuvera', 'nps', 'ppf'],
  Fuel: ['petrol', 'fuel', 'hpcl', 'bpcl', 'iocl', 'indianoil', 'shell', 'chevron', 'exxon', 'exxonmobil'],
  Health: ['pharmacy', 'apollo', 'medplus', 'hospital', 'clinic', 'netmeds', 'pharmeasy', 'practo'],
  Subscriptions: ['netflix', 'spotify', 'hotstar', 'youtube', 'hulu', 'disneyplus'],
  Interest: ['interest'],
}

/** A known category for a word (lower case), if there is one. */
export function knownCategory(word: string): string | undefined {
  const w = word.toLowerCase()
  return Object.keys(KNOWN).find((k) => KNOWN[k].includes(w))
}

/** Starting rules from the words a column has: each known word under its category, in the order categories are listed. */
export function suggestRules(words: string[]): CategoryRule[] {
  const by = new Map<string, string[]>()
  for (const w of words) {
    const k = knownCategory(w)
    if (k) by.set(k, [...(by.get(k) ?? []), w.toLowerCase()])
  }
  return Object.keys(KNOWN)
    .filter((k) => by.has(k))
    .map((category) => ({ category, words: by.get(category)! }))
}

/** A name for the new column that isn't taken: category, category_2… */
export function categoryName(taken: string[]): string {
  const t = new Set(taken.map((x) => x.toLowerCase()))
  if (!t.has('category')) return 'category'
  let i = 2
  while (t.has(`category_${i}`)) i++
  return `category_${i}`
}
