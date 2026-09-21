import React from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import { CheckCircle, AlertTriangle, AlertOctagon, Info, X } from 'lucide-react';

export const ToastContainer: React.FC = () => {
  const { toasts } = useWoprStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((toast) => {
        const Icon = {
          success: CheckCircle,
          warn: AlertTriangle,
          err: AlertOctagon,
          info: Info,
        }[toast.type];

        const colors = {
          success: 'bg-[#161b22] border-[#3fb950]/40 text-[#3fb950]',
          warn: 'bg-[#161b22] border-[#d29922]/40 text-[#d29922]',
          err: 'bg-[#161b22] border-[#f85149]/40 text-[#f85149]',
          info: 'bg-[#161b22] border-wopr-accent/40 text-wopr-accent',
        }[toast.type];

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-xl border shadow-2xl backdrop-blur-md transition-all duration-200 animate-in slide-in-from-bottom-3 ${colors}`}
          >
            <Icon className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h4 className="text-xs font-semibold text-wopr-text tracking-wide">{toast.title}</h4>
              {toast.message && (
                <p className="text-xs text-wopr-textMuted mt-0.5 leading-snug break-words">
                  {toast.message}
                </p>
              )}
            </div>
            <button
              onClick={() => store.removeToast(toast.id)}
              className="text-wopr-textMuted hover:text-wopr-text p-1 rounded hover:bg-white/5 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
