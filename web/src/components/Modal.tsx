import { ReactNode, useEffect, useRef } from 'react';

interface Props {
  title: string;
  children: ReactNode;
  onClose: () => void;
}

export function Modal({ title, children, onClose }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);

  // Bound to the modal's OWN document, not `window`: a pane popped out into a
  // floating window renders its modals there, where the main page never sees
  // the keypress.
  useEffect(() => {
    const doc = backdropRef.current?.ownerDocument ?? document;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={backdropRef}
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card">
        <div className="modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}
