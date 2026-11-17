// Hover cards. Drawn in a layer above the page, positioned from the target's
// box, so clipped cells and scrolling panels never cut them off.

import { useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { createPortal } from "react-dom";

type Place = { left: number; top: number; below: boolean };

const GAP = 8;

function placeOf(target: HTMLElement): Place {
  const box = target.getBoundingClientRect();
  const below = box.top < 120;

  return {
    left: Math.min(Math.max(box.left + box.width / 2, 16), window.innerWidth - 16),
    top: below ? box.bottom + GAP : box.top - GAP,
    below,
  };
}

type TooltipProps = {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  /** Only show when the text inside has been cut off with an ellipsis. */
  whenClipped?: boolean;
};

export function Tooltip({ content, children, className, whenClipped }: TooltipProps): JSX.Element {
  const [place, setPlace] = useState<Place | null>(null);
  const target = useRef<HTMLSpanElement>(null);

  const show = (): void => {
    const node = target.current;

    if (node !== null && (whenClipped !== true || node.scrollWidth > node.clientWidth)) {
      setPlace(placeOf(node));
    }
  };

  return (
    <span
      ref={target}
      className={className}
      onMouseEnter={show}
      onMouseLeave={() => setPlace(null)}
      onFocus={show}
      onBlur={() => setPlace(null)}
    >
      {children}
      {place !== null &&
        createPortal(
          <div
            className={place.below ? "tooltip below" : "tooltip"}
            style={{ left: place.left, top: place.top }}
            role="tooltip"
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** Text that ends in an ellipsis when it does not fit, and shows in full on hover. */
export function Clipped({ text, className }: { text: string; className?: string }): JSX.Element {
  return (
    <Tooltip
      content={text}
      className={className === undefined ? "clip" : `clip ${className}`}
      whenClipped
    >
      {text}
    </Tooltip>
  );
}
