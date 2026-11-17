// A foldable section of the event body. Whether it is folded is remembered
// per section; a link to `#id` opens it.

import { useState } from "react";
import type { JSX, ReactNode, SyntheticEvent } from "react";

import { readSetting, writeSetting } from "~/lib/storage";

type SectionProps = {
  id: string;
  title: string;
  children: ReactNode;
  /** Controls shown at the right of the title while the section is open. */
  actions?: ReactNode;
  folded?: boolean;
};

const settingOf = (id: string): string => `fold:${id}`;

function startsOpen(id: string, folded: boolean): boolean {
  if (window.location.hash === `#${id}`) {
    return true;
  }

  const saved = readSetting(settingOf(id));

  return saved === null ? !folded : saved === "open";
}

export function Section({
  id,
  title,
  children,
  actions,
  folded = false,
}: SectionProps): JSX.Element {
  const [open, setOpen] = useState(() => startsOpen(id, folded));

  const toggled = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    const next = event.currentTarget.open;

    if (next !== open) {
      setOpen(next);
      writeSetting(settingOf(id), next === !folded ? null : next ? "open" : "closed");
    }
  };

  return (
    <details className="section" id={id} open={open} onToggle={toggled}>
      <summary>
        <span>{title}</span>
        {open && actions !== undefined && (
          <span className="section-actions" onClick={(event) => event.preventDefault()}>
            {actions}
          </span>
        )}
      </summary>
      <div className="body">{children}</div>
    </details>
  );
}

/** Opens a section and scrolls to it, for the "Jump to" links. */
export function jumpTo(id: string): void {
  const target = document.querySelector(`#${CSS.escape(id)}`);

  if (target instanceof HTMLDetailsElement) {
    target.open = true;
  }

  target?.scrollIntoView({ behavior: "smooth", block: "start" });
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#${id}`,
  );
}

type SwitchProps<T extends string> = {
  options: readonly (readonly [value: T, label: string])[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
};

/** A small segmented control: "Formatted | Raw", "Newest | Oldest". */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: SwitchProps<T>): JSX.Element {
  return (
    <span className="segmented" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          className={option === value ? "active" : undefined}
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </span>
  );
}
