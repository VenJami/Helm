import { useEffect, useState } from 'react';
import { IconX } from './Icons';

// Transient action feedback (a failed switch, a revive error, "notifications
// blocked") that used to jam red text into the toolbar. A module-level event
// bus lets any component raise a toast without prop-drilling.

export type ToastKind = 'error' | 'success' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

let seq = 0;
function emit(kind: ToastKind, message: string) {
  if (!message) return;
  window.dispatchEvent(new CustomEvent('helm:toast', { detail: { id: ++seq, kind, message } }));
}

export const toast = {
  error: (m: string) => emit('error', m),
  success: (m: string) => emit('success', m),
  info: (m: string) => emit('info', m),
};

// Errors linger longest (you may have looked away); success is briefest.
const TTL: Record<ToastKind, number> = { error: 7000, success: 4000, info: 5000 };

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const onToast = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setToasts((prev) => [...prev, t].slice(-4)); // cap the visible stack
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), TTL[t.kind]);
    };
    window.addEventListener('helm:toast', onToast);
    return () => window.removeEventListener('helm:toast', onToast);
  }, []);

  const dismiss = (id: number) => setToasts((prev) => prev.filter((x) => x.id !== id));
  if (!toasts.length) return null;
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role="alert">
          <span className="toast-msg">{t.message}</span>
          <button className="toast-close" title="Dismiss" onClick={() => dismiss(t.id)}>
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
