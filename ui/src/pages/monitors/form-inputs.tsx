// Inputs whose raw text can be wrong. The draft only ever holds valid values:
// while a field's text is invalid it keeps what was typed, says why, and
// blocks saving, instead of coercing "" or "-3" into a number nobody typed.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { JSX } from "react";

type Report = (field: string, problem: string | null) => void;

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

const ValidityContext = createContext<Report | null>(null);

export const ValidityProvider = ValidityContext.Provider;

/** Each invalid field's problem, by field; the form saves only while this is empty. */
export function useProblems(): [Record<string, string>, Report] {
  const [problems, setProblems] = useState<Record<string, string>>({});

  const report = useCallback<Report>((field, problem) => {
    setProblems((current) => {
      if (problem === null) {
        return field in current
          ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== field))
          : current;
      }

      return current[field] === problem ? current : { ...current, [field]: problem };
    });
  }, []);

  return [problems, report];
}

function useReport(): Report {
  const report = useContext(ValidityContext);

  if (report === null) {
    throw new Error("A validated input must sit inside a monitor form's ValidityProvider");
  }

  return report;
}

type TextState = { text: string; shown: string; problem: string | null };

export type ValidatedText = {
  text: string;
  problem: string | null;
  change: (text: string) => void;
};

/**
 * The field's raw text and its problem. `shown` is the draft value the text
 * last matched: when the draft changes from elsewhere (a reset, a default)
 * the text follows it, unless the user has invalid text pending, which wins
 * until fixed.
 */
export function useValidatedText<T>(input: {
  field: string;
  value: T;
  format: (value: T) => string;
  parse: (text: string) => Parsed<T>;
  set: (value: T) => void;
}): ValidatedText {
  const report = useReport();
  const formatted = input.format(input.value);

  const [state, setState] = useState<TextState>({
    text: formatted,
    shown: formatted,
    problem: null,
  });

  const { field } = input;

  // React's sanctioned "adjust state while rendering" pattern, not an effect,
  // so the input never renders a stale value for a frame.
  if (state.problem === null && state.shown !== formatted) {
    setState({ text: formatted, shown: formatted, problem: null });
  }

  // A field that unmounts (a section switched away) no longer blocks saving.
  useEffect(() => () => report(field, null), [field, report]);

  const change = (text: string): void => {
    const parsed = input.parse(text);

    if (parsed.ok) {
      setState({ text, shown: input.format(parsed.value), problem: null });
      report(field, null);
      input.set(parsed.value);
    } else {
      setState({ text, shown: state.shown, problem: parsed.problem });
      report(field, parsed.problem);
    }
  };

  return { text: state.text, problem: state.problem, change };
}

/** Whole numbers in [min, max]; "" is valid only when the field is optional. */
function parseWhole(text: string, range: { min: number; max: number }): Parsed<number> {
  const trimmed = text.trim();

  if (!/^\d+$/u.test(trimmed)) {
    return { ok: false, problem: "Enter a whole number." };
  }

  const value = Number(trimmed);

  if (value < range.min || value > range.max) {
    return { ok: false, problem: `Enter a number from ${range.min} to ${range.max}.` };
  }

  return { ok: true, value };
}

type NumberBase = {
  /** The field's name, used as its accessible name and its problem's key. */
  label: string;
  min: number;
  max: number;
  placeholder?: string;
};

type NumberProps =
  | (NumberBase & { optional?: false; value: number; set: (value: number) => void })
  | (NumberBase & {
      optional: true;
      value: number | undefined;
      set: (value: number | undefined) => void;
    });

function useNumberText(props: NumberProps): ValidatedText {
  const range = { min: props.min, max: props.max };

  return useValidatedText<number | undefined>({
    field: props.label,
    value: props.value,
    format: (value) => (value === undefined ? "" : String(value)),
    parse: (text) => {
      if (text.trim() === "") {
        return props.optional === true
          ? { ok: true, value: undefined }
          : { ok: false, problem: "Enter a number." };
      }

      return parseWhole(text, range);
    },
    set: (value) => {
      if (props.optional === true) {
        props.set(value);
      } else if (value === undefined) {
        throw new Error(`${props.label} parsed empty text as valid`);
      } else {
        props.set(value);
      }
    },
  });
}

/** A whole-number input; text, not type="number", so a typo is seen rather than dropped. */
export function WholeNumberInput(props: NumberProps): JSX.Element {
  const { text, problem, change } = useNumberText(props);

  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        aria-label={props.label}
        aria-invalid={problem !== null}
        placeholder={props.placeholder}
        value={text}
        onChange={(event) => change(event.target.value)}
      />
      {problem !== null && (
        <span className="field-error" role="alert">
          {problem}
        </span>
      )}
    </>
  );
}
