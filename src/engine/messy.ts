import { LOCALE } from './sql'

/*
 * A small, realistically messy export: the kind an accounting package writes for "Sales register,
 * April". Everything Sheetah's clean-up is for is in it, the way it turns up in real files:
 *   - a region named once per group (fill down), with a "Sub-total" line after each and a "Grand Total"
 *   - empty rows between the groups
 *   - amounts as text with a currency sign and thousands separators, a credit note in brackets: in
 *     rupees with Indian grouping (1,12,500.00) and GST for India and the rest, in dollars with sales
 *     tax for a reader in the US
 *   - tax rates as "18%", dates as "03-Apr-2024"
 *   - customers typed with stray spaces and any case, one city spelt two ways
 * Built here (no download, no file in the bundle's assets) and opened like any file the user drops.
 */

const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

type Line = [invoice: string, day: number, customer: string, city: string, taxable: number, gst: number]

const REGIONS: { region: string; lines: Line[] }[] = [
  {
    region: 'North',
    lines: [
      ['INV-0101', 1, ' asha rao ', 'Delhi', 12500, 18],
      ['INV-0102', 3, 'RAVI KUMAR', 'New Delhi', 8200, 12],
      ['INV-0103', 4, 'Kabir  Khan', 'Gurugram', 112500, 18],
      ['INV-0104', 8, 'meera iyer', 'Noida', 4750, 5],
      ['CN-0007', 9, 'RAVI KUMAR', 'New Delhi', -1200, 12],
      ['INV-0105', 15, 'Diya Sharma', 'Delhi', 26400, 18],
    ],
  },
  {
    region: 'South',
    lines: [
      ['INV-0201', 2, 'ananya das', 'Bangalore', 18900, 18],
      ['INV-0202', 5, 'Arjun Reddy ', 'Chennai', 7300, 12],
      ['INV-0203', 10, 'VIHAAN MEHTA', 'Bengaluru', 245000, 18],
      ['INV-0204', 12, 'isha bose', 'Hyderabad', 3150, 5],
      ['INV-0205', 18, ' Rohan Patel', 'Bangalore', 15600, 18],
    ],
  },
  {
    region: 'West',
    lines: [
      ['INV-0301', 2, 'sara khan', 'Mumbai', 54000, 18],
      ['INV-0302', 6, 'Leo  Garcia', 'Pune', 9800, 12],
      ['INV-0303', 11, 'MIA SMITH', 'Ahmedabad', 2100, 5],
      ['INV-0304', 19, 'noah tanaka', 'Mumbai', 33750, 18],
      ['INV-0305', 24, 'Zoe Okafor', 'Pune', 61200, 18],
    ],
  },
]

/** The same register as a US business would have it: dollars, sales tax, its customers and cities (New York spelt two ways). */
const US: { names: string[]; cities: string[]; rates: Record<number, number> } = {
  names: [' emma clark ', 'LIAM JONES', 'Olivia  Brown', 'noah davis', 'LIAM JONES', 'Ava Miller', 'mason wilson', 'Ethan Moore ', 'SOPHIA TAYLOR', 'jacob lee', ' Mia Anderson', 'lucas thomas', 'Amelia  Jackson', 'HARPER WHITE', 'elijah harris', 'Grace Martin'],
  cities: ['Boston', 'Cambridge', 'Providence', 'Hartford', 'Cambridge', 'Boston', 'Atlanta', 'Miami', 'NYC', 'Charlotte', 'New York', 'Denver', 'Austin', 'Phoenix', 'Denver', 'Austin'],
  rates: { 18: 8, 12: 6, 5: 4 },
}

export const MESSY_NAME = 'sales_register_april.csv'

/** The messy register: India's (₹, GST) unless `us` (dollars and sales tax, for a reader in the US). */
export function messyCsv(us = false): string {
  const grouping = new Intl.NumberFormat(us ? 'en-US' : 'en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const sign = us ? '$' : '₹'
  const money = (n: number, symbol = true) => (n < 0 ? `(${symbol ? sign : ''}${grouping.format(-n)})` : `${symbol ? sign : ''}${grouping.format(n)}`)
  const rows: string[][] = [['Region', 'Invoice No', 'Invoice Date', 'Customer', 'City', 'Taxable Value', us ? 'Tax %' : 'GST %', 'Invoice Total']]
  let grandTaxable = 0
  let grandTotal = 0
  let k = 0
  REGIONS.forEach(({ region, lines }, g) => {
    let taxable = 0
    let total = 0
    lines.forEach(([invoice, day, inCustomer, inCity, value, inGst], i) => {
      const [customer, city, gst] = us ? [US.names[k], US.cities[k], US.rates[inGst]] : [inCustomer, inCity, inGst]
      k++
      const withTax = Math.round(value * (100 + gst)) / 100
      taxable += value
      total += withTax
      // Some rows were typed without the currency sign: the clean-up reads both.
      const symbol = (i + g) % 3 !== 2
      rows.push([i === 0 ? region : '', invoice, `${String(day).padStart(2, '0')}-Apr-2024`, customer, city, money(value, symbol), `${gst}%`, money(withTax, symbol)])
    })
    rows.push(['Sub-total', '', '', '', '', money(taxable), '', money(total)])
    rows.push(['', '', '', '', '', '', '', ''])
    grandTaxable += taxable
    grandTotal += total
  })
  rows.push(['Grand Total', '', '', '', '', money(grandTaxable), '', money(grandTotal)])
  return rows.map((r) => r.map(csv).join(',')).join('\n') + '\n'
}

export const messyFile = () => new File([messyCsv(/^en-US$/i.test(LOCALE))], MESSY_NAME, { type: 'text/csv' })
