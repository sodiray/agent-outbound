import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// A small info icon that reveals descriptive/definition text on hover or focus.
// The bubble is portaled to <body> with position:fixed so it is never clipped by
// a scrolling panel's overflow, and clamped to stay on-screen.
export const InfoTooltip = ({ text }: { text: string }) => {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  if (!text) return null;
  const show = () => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 308));
    setPos({ top: rect.bottom + 6, left });
  };
  const hide = () => setPos(null);
  return (
    <span
      ref={ref}
      className="info-tip"
      tabIndex={0}
      role="img"
      aria-label={text}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <svg className="info-tip__icon" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="8" cy="4.7" r="0.95" fill="currentColor" />
        <rect x="7.2" y="6.8" width="1.6" height="5" rx="0.8" fill="currentColor" />
      </svg>
      {pos
        ? createPortal(
            <span className="info-tip__bubble" role="tooltip" style={{ top: pos.top, left: pos.left }}>{text}</span>,
            document.body,
          )
        : null}
    </span>
  );
};
