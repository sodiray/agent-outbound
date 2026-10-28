import { useEffect, type ReactNode } from 'react';

export const DetailDrawer = ({
  open,
  onClose,
  onEscape,
  ariaLabel = 'Record detail',
  className = '',
  children,
}: {
  open: boolean;
  onClose: () => void;
  // Escape closes the drawer unless the panel handles it (e.g. to step back).
  onEscape?: (event: KeyboardEvent) => void;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}) => {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (onEscape) onEscape(event);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, onEscape]);

  return (
    <div className={`drawer-root ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <button className="scrim" type="button" aria-label={`Close ${ariaLabel.toLowerCase()}`} onClick={onClose} />
      <aside className={`detail-panel ${className}`.trim()} aria-label={ariaLabel}>
        <button className="close-button" type="button" onClick={onClose} aria-label="Close">×</button>
        {children}
      </aside>
    </div>
  );
};
