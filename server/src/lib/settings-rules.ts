import { badRequest, notFound } from './errors.js';

/**
 * Settings are stored as text so an administrator can change them without a
 * deployment, but the system reads some of them as numbers: invoice preparation
 * turns vat_rate into one, and a database trigger casts max_hours_per_day to
 * numeric on every timesheet save. A value that is not a number does not fail
 * where it is typed; it fails later, in someone else's request, until it is
 * corrected. So every setting has a rule, checked when it is saved.
 *
 * A rule returns the value to store (tidied) or throws a message the person
 * editing can act on. A key with no rule does not exist.
 */
type Rule = (raw: string) => string;

const CONTROL = /[\u0000-\u001f\u007f]/;

function text(label: string, max: number, pattern?: RegExp, patternHelp?: string): Rule {
  return (raw) => {
    const v = raw.trim();
    if (!v) throw badRequest(`${label} cannot be empty.`);
    if (v.length > max) throw badRequest(`${label} must be ${max} characters or fewer.`);
    if (CONTROL.test(v)) throw badRequest(`${label} cannot contain line breaks or control characters.`);
    if (pattern && !pattern.test(v)) throw badRequest(`${label} ${patternHelp}.`);
    return v;
  };
}

/** A plain number written with digits and at most `places` decimals: no signs, no exponents. */
function number(label: string, min: number, max: number, places: number, minExclusive = false): Rule {
  const shape = places === 0 ? /^\d{1,6}$/ : new RegExp(`^\\d{1,6}(\\.\\d{1,${places}})?$`);
  return (raw) => {
    const v = raw.trim();
    if (!shape.test(v)) {
      throw badRequest(places === 0
        ? `${label} must be a whole number.`
        : `${label} must be a number with at most ${places} decimal places.`);
    }
    const n = Number(v);
    if (minExclusive ? n <= min : n < min) {
      throw badRequest(`${label} must be ${minExclusive ? 'more than' : 'at least'} ${min}.`);
    }
    if (n > max) throw badRequest(`${label} must be ${max} or less.`);
    return v;
  };
}

function oneOf(label: string, allowed: string[]): Rule {
  return (raw) => {
    const v = raw.trim().toUpperCase();
    if (!allowed.includes(v)) throw badRequest(`${label} must be one of: ${allowed.join(', ')}.`);
    return v;
  };
}

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

/** "60,30,14": between one and ten distinct whole numbers of days, each 1 to 365. */
const dayList: Rule = (raw) => {
  const parts = raw.split(',').map((p) => p.trim());
  const label = 'Placement alert days';
  if (parts.length > 10 || parts.some((p) => !/^\d{1,3}$/.test(p))) {
    throw badRequest(`${label} must be up to 10 whole numbers of days separated by commas, for example 60,30,14.`);
  }
  const days = parts.map(Number);
  if (days.some((d) => d < 1 || d > 365)) throw badRequest(`${label} must each be between 1 and 365.`);
  if (new Set(days).size !== days.length) throw badRequest(`${label} cannot repeat a number.`);
  return days.join(',');
};

export const SETTING_RULES: Record<string, Rule> = {
  company_name: text('Company name', 200),
  company_registration: text('Company registration', 50),
  company_bank: text('Banking details', 200),
  vat_registered: oneOf('VAT registered', ['TRUE', 'FALSE']), // stored lower case below
  vat_rate: number('VAT rate', 0, 100, 2),
  timesheet_cycle: oneOf('Timesheet cycle', ['WEEKLY']),
  week_starts_on: oneOf('Week starts on', WEEKDAYS),
  timesheet_due_day: oneOf('Timesheet due day', WEEKDAYS),
  reminder_lead_hours: number('Reminder lead time', 0, 720, 0),
  approval_escalation_hours: number('Approval escalation time', 0, 720, 0),
  // 0 would reject every hour; the day has 24. The trigger compares against this.
  max_hours_per_day: number('Maximum hours per day', 0, 24, 2, true),
  placement_alert_days: dayList,
  candidate_retention_months: number('Candidate retention', 1, 240, 0),
  financial_retention_years: number('Financial retention', 1, 100, 0),
  invoice_prefix: text('Invoice prefix', 10, /^[A-Za-z0-9\-_/]+$/, 'can only use letters, digits, - _ and /'),
};

/** The value to store for this setting, or an AppError saying why not. */
export function checkSetting(key: string, raw: string): string {
  const rule = Object.prototype.hasOwnProperty.call(SETTING_RULES, key) ? SETTING_RULES[key] : undefined;
  if (!rule) throw notFound('That setting does not exist.');
  const v = rule(raw);
  return key === 'vat_registered' ? v.toLowerCase() : v;
}
