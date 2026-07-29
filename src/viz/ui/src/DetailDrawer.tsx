import { useEffect, type ReactNode } from 'react';

export const DetailDrawer = ({
  open,
  onClose,
  ariaLabel = 'Record detail',
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  children: ReactNode;
}) => {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  return (
    <div className={`drawer-root ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <button className="scrim" type="button" aria-label={`Close ${ariaLabel.toLowerCase()}`} onClick={onClose} />
      <aside className="detail-panel" aria-label={ariaLabel}>
        <button className="close-button" type="button" onClick={onClose} aria-label="Close">×</button>
        {children}
      </aside>
    </div>
  );
};
