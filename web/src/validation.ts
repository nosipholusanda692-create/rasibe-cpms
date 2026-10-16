import { useCallback, useMemo, useState } from 'react';

/**
 * Front-end validation.
 *
 * This is for the person filling the form in, not for the system. Every rule
 * here is also enforced on the server, and several are enforced again as
 * database constraints. Nothing may be relaxed on the server because a check
 * exists here: a form in a browser is under the user's control and cannot be
 * trusted (NFR-SEC-006).
 *
 * What it buys is a field that says what is wrong the moment the person leaves
 * it, rather than a round trip that rejects the whole form.
 */

export type Rule<T = string> = (value: T, form: Record<string, any>) => string | undefined;

// ---------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------
export const required = (label = 'This'): Rule =>
  (v) => (v === undefined || v === null || String(v).trim() === '' ? `${label} is required` : undefined);

export const minLength = (n: number, label = 'This'): Rule =>
  (v) => (v && String(v).trim().length < n
    ? `${label} must be at least ${n} characters` : undefined);

export const maxLength = (n: number, label = 'This'): Rule =>
  (v) => (v && String(v).length > n ? `${label} must be ${n} characters or fewer` : undefined);

/**
 * Deliberately permissive. A stricter pattern rejects addresses that are
 * perfectly valid, and the server is the authority in any case.
 */
export const email: Rule = (v) => {
  if (!v) return undefined;
  const s = String(v).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return 'Enter a valid email address, such as name@company.co.za';
  return undefined;
};

export const number = (label = 'This'): Rule => (v) => {
  if (v === '' || v === undefined || v === null) return undefined;
  return Number.isNaN(Number(v)) ? `${label} must be a number` : undefined;
};

export const min = (n: number, label = 'This'): Rule => (v) => {
  if (v === '' || v === undefined || v === null) return undefined;
  return Number(v) < n ? `${label} cannot be less than ${n}` : undefined;
};

export const max = (n: number, label = 'This'): Rule => (v) => {
  if (v === '' || v === undefined || v === null) return undefined;
  return Number(v) > n ? `${label} cannot be more than ${n}` : undefined;
};

export const integer = (label = 'This'): Rule => (v) => {
  if (v === '' || v === undefined || v === null) return undefined;
  return Number.isInteger(Number(v)) ? undefined : `${label} must be a whole number`;
};

/** BR-004 — hours are never recorded against a day that has not happened. */
export const notFuture = (label = 'The date'): Rule => (v) => {
  if (!v) return undefined;
  const today = new Date().toISOString().slice(0, 10);
  return String(v) > today ? `${label} cannot be in the future` : undefined;
};

export const notPast = (label = 'The date'): Rule => (v) => {
  if (!v) return undefined;
  const today = new Date().toISOString().slice(0, 10);
  return String(v) < today ? `${label} cannot be in the past` : undefined;
};

/** BR-014 — an engagement cannot finish before it starts. */
export const afterField = (other: string, label = 'The end date', otherLabel = 'the start date'): Rule =>
  (v, form) => {
    if (!v || !form[other]) return undefined;
    return String(v) <= String(form[other])
      ? `${label} must be later than ${otherLabel}` : undefined;
  };

/**
 * The rate guard. A placement that pays more than it bills loses money on every
 * hour worked, and the database refuses it outright, so catching it here saves
 * the person discovering it on submit.
 */
export const notAbove = (other: string, label = 'This', otherLabel = 'the other'): Rule =>
  (v, form) => {
    if (v === '' || !form[other]) return undefined;
    return Number(v) > Number(form[other])
      ? `${label} cannot exceed ${otherLabel}` : undefined;
  };

export const matches = (other: string, label = 'The two entries'): Rule =>
  (v, form) => (v && form[other] && v !== form[other] ? `${label} do not match` : undefined);

/** The password policy, matching the server rule exactly. */
export const passwordPolicy: Rule = (v) => {
  if (!v) return undefined;
  const s = String(v);
  if (s.length < 10) return 'Use at least 10 characters';
  if (!/[A-Z]/.test(s)) return 'Include an upper case letter';
  if (!/[a-z]/.test(s)) return 'Include a lower case letter';
  if (!/[0-9]/.test(s)) return 'Include a number';
  return undefined;
};

export const passwordChecks = (v: string) => [
  { ok: v.length >= 10, text: 'At least 10 characters' },
  { ok: /[A-Z]/.test(v), text: 'An upper case letter' },
  { ok: /[a-z]/.test(v), text: 'A lower case letter' },
  { ok: /[0-9]/.test(v), text: 'A number' },
];

/** BR-005 and the override rules: a reason that explains nothing is no reason. */
export const reason: Rule = (v) => {
  if (!v || String(v).trim().length < 5) {
    return 'Give a reason of at least five characters, so the other person knows what to do';
  }
  return undefined;
};

export const phone: Rule = (v) => {
  if (!v) return undefined;
  return /^[0-9+\s()-]{6,20}$/.test(String(v).trim())
    ? undefined : 'Enter a valid phone number';
};

// ---------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------
export type Schema = Record<string, Rule[]>;

/**
 * Holds the form, runs the rules, and decides when a message is helpful.
 *
 * A field is not marked wrong while it is still being filled in. The error
 * appears when the person leaves the field, or when they try to submit, which
 * keeps the form quiet until it has something useful to say.
 */
export function useForm<T extends Record<string, any>>(initial: T, schema: Schema) {
  const [values, setValues] = useState<T>(initial);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverFields, setServerFields] = useState<Record<string, string[]>>({});

  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [field, rules] of Object.entries(schema)) {
      for (const rule of rules) {
        const message = rule(values[field], values);
        if (message) { out[field] = message; break; }
      }
    }
    return out;
  }, [values, schema]);

  const set = useCallback((field: keyof T, value: any) => {
    setValues((v) => ({ ...v, [field]: value }));
    // a server complaint about this field is stale the moment it is edited
    setServerFields((s) => {
      if (!s[field as string]) return s;
      const next = { ...s };
      delete next[field as string];
      return next;
    });
  }, []);

  const blur = useCallback((field: keyof T) => {
    setTouched((t) => ({ ...t, [field as string]: true }));
  }, []);

  /** The message to show, or nothing while the field is still being worked on. */
  const errorFor = useCallback((field: keyof T): string | undefined => {
    const name = field as string;
    if (serverFields[name]?.[0]) return serverFields[name][0];
    if (!submitted && !touched[name]) return undefined;
    return errors[name];
  }, [errors, touched, submitted, serverFields]);

  const fieldProps = useCallback((field: keyof T) => ({
    value: values[field] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      set(field, e.target.value),
    onBlur: () => blur(field),
    'aria-invalid': errorFor(field) ? true : undefined,
  }), [values, set, blur, errorFor]);

  const isValid = Object.keys(errors).length === 0;

  /**
   * Marks everything touched so nothing is wrong-but-silent, and reports
   * whether the form may be sent.
   */
  const attemptSubmit = useCallback(() => {
    setSubmitted(true);
    setTouched(Object.fromEntries(Object.keys(schema).map((k) => [k, true])));
    return Object.keys(errors).length === 0;
  }, [errors, schema]);

  /** Field-level messages returned by the server are shown in the same place. */
  const applyServerErrors = useCallback((detail?: Record<string, string[]>) => {
    setServerFields(detail ?? {});
  }, []);

  const reset = useCallback((next?: T) => {
    setValues(next ?? initial);
    setTouched({});
    setSubmitted(false);
    setServerFields({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    values, set, blur, errors, errorFor, fieldProps,
    isValid, attemptSubmit, applyServerErrors, reset, submitted,
  };
}
