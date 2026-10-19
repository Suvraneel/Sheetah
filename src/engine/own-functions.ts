/**
 * Sheetah's own SQL functions (macros every connection has, see CLEAN_MACROS and pseudonym in db.ts): how
 * each is written and what it does. Offered as the editor completes a word, and said when one is given
 * values it doesn't take.
 */
export const OWN_FUNCTIONS: Record<string, { shape: string; does: string }> = {
  number_from_text: { shape: 'number_from_text(amount)', does: 'Text written as a number (“1,234.50”, “₹ 1,234”, “(500)”) as a number; empty if it isn’t one.' },
  number_from_text_comma: { shape: 'number_from_text_comma(amount)', does: 'The same, for numbers written with a decimal comma: “1.234,50”.' },
  number_from_cr_dr: { shape: 'number_from_cr_dr(amount)', does: 'An amount marked Cr or Dr (“1,200 Cr”) as a signed number: Cr +, Dr −.' },
  percent_from_text: { shape: 'percent_from_text(rate)', does: '“18%” as 0.18.' },
  percent_from_text_comma: { shape: 'percent_from_text_comma(rate)', does: '“18,5%” as 0.185.' },
  date_from_text: { shape: "date_from_text(day, '%d/%m/%Y')", does: 'Text as a date, read with how it’s written (%d day, %m month, %Y year, %b Jan…).' },
  tidy_spaces: { shape: 'tidy_spaces(name)', does: 'Spaces at the ends taken off and runs of them made one; empty if nothing is left.' },
  title_case: { shape: 'title_case(name)', does: '“asha RAO” as “Asha Rao”.' },
  has_value: { shape: 'has_value(x)', does: 'Whether there’s anything in it: not empty, not just spaces.' },
  pseudonym: { shape: 'pseudonym(email)', does: 'The same stand-in for the same value, made with this browser’s key: data to share without the names.' },
}
