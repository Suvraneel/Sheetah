/*
 * A small, realistically messy export: the kind an accounting package writes for "Sales register,
 * April". Everything Sheetah's clean-up is for is in it, the way it turns up in real files:
 *   - a region named once per group (fill down), with a "Sub-total" line after each and a "Grand Total"
 *   - empty rows between the groups
 *   - amounts as text with ₹ and Indian grouping (1,12,500.00), a credit note in brackets
 *   - GST rates as "18%", dates as "03-Apr-2024"
 *   - customers typed with stray spaces and any case, one city spelt two ways
 * Built here (no download, no file in the bundle's assets) and opened like any file the user drops.
 */

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money = (n: number, symbol = true) => (n < 0 ? `(${symbol ? '₹' : ''}${inr.format(-n)})` : `${symbol ? '₹' : ''}${inr.format(n)}`)
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

export const MESSY_NAME = 'sales_register_april.csv'

export function messyCsv(): string {
  const rows: string[][] = [['Region', 'Invoice No', 'Invoice Date', 'Customer', 'City', 'Taxable Value', 'GST %', 'Invoice Total']]
  let grandTaxable = 0
  let grandTotal = 0
  REGIONS.forEach(({ region, lines }, g) => {
    let taxable = 0
    let total = 0
    lines.forEach(([invoice, day, customer, city, value, gst], i) => {
      const withTax = Math.round(value * (100 + gst)) / 100
      taxable += value
      total += withTax
      // Some rows were typed without the ₹ sign: the clean-up reads both.
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

export const messyFile = () => new File([messyCsv()], MESSY_NAME, { type: 'text/csv' })
