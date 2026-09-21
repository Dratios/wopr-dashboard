import React, { useState, useEffect, useRef } from 'react';
import { AlertTriangle, AlertOctagon, X, Clock, ShieldAlert } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: React.ReactNode;
  isDestructive?: boolean;
  requireTextMatch?: string; // Text the user must type to confirm
  requireReason?: boolean; // Requires entering a reason
  countdownSeconds?: number; // Countdown before action or cancel window
  otherAdminWarning?: string; // ex. « Ce conteneur appartient à @coadmin »
  confirmText?: string;
  cancelText?: string;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  description,
  isDestructive = false,
  requireTextMatch,
  requireReason = false,
  countdownSeconds,
  otherAdminWarning,
  confirmText = 'Confirmer',
  cancelText = 'Annuler',
  onConfirm,
  onCancel,
}) => {
  const [typedText, setTypedText] = useState('');
  const [reason, setReason] = useState('');
  const [countdown, setCountdown] = useState<number | null>(countdownSeconds || null);
  const [isCountingDown, setIsCountingDown] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTypedText('');
      setReason('');
      setCountdown(countdownSeconds || null);
      setIsCountingDown(false);
    }
  }, [isOpen, countdownSeconds]);

  // `onConfirm` est une fonction recréée à chaque rendu du parent (donc toutes les
  // 2 s avec le flux temps réel) : la garder dans une ref évite de relancer le
  // minuteur à chaque rendu.
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  // Countdown timer logic
  useEffect(() => {
    if (!isCountingDown || countdown === null) return;
    if (countdown <= 0) {
      setIsCountingDown(false);
      onConfirmRef.current(reason);
      return;
    }
    const timer = window.setTimeout(() => setCountdown((c) => (c !== null ? c - 1 : null)), 1000);
    return () => window.clearTimeout(timer);
  }, [isCountingDown, countdown, reason]);

  if (!isOpen) return null;

  const isMatchValid = !requireTextMatch || typedText.trim() === requireTextMatch;
  const isReasonValid = !requireReason || reason.trim().length > 3;
  const canConfirm = isMatchValid && isReasonValid;

  const handleStartConfirmation = () => {
    if (countdownSeconds && countdownSeconds > 0 && !isCountingDown) {
      setIsCountingDown(true);
      return;
    }
    onConfirm(reason);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-lg bg-[#161b22] border border-wopr-border rounded-xl shadow-2xl p-6 overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <div
              className={`p-2.5 rounded-lg shrink-0 ${
                isDestructive
                  ? 'bg-rose-500/15 text-rose-500 border border-rose-500/30'
                  : 'bg-amber-500/15 text-amber-500 border border-amber-500/30'
              }`}
            >
              {isDestructive ? (
                <AlertOctagon className="w-5 h-5" />
              ) : (
                <AlertTriangle className="w-5 h-5" />
              )}
            </div>
            <h3 className="text-base font-semibold text-wopr-text tracking-wide">{title}</h3>
          </div>
          <button
            onClick={onCancel}
            className="text-wopr-textMuted hover:text-wopr-text p-1 rounded-lg hover:bg-white/5 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Other Admin Governance Alert */}
        {otherAdminWarning && (
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-start gap-2.5 text-xs text-amber-300">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">{otherAdminWarning}</p>
              <p className="text-amber-300/80 mt-0.5">
                L'action sera inscrite à votre nom dans le journal d'audit.
              </p>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="text-sm text-wopr-textMuted mb-5 leading-relaxed">{description}</div>

        {/* Input Match Requirement */}
        {requireTextMatch && (
          <div className="mb-4">
            <label className="block text-xs font-medium text-wopr-text mb-1.5">
              Pour confirmer, veuillez saisir <span className="font-mono text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded font-bold">{requireTextMatch}</span> :
            </label>
            <input
              type="text"
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              placeholder={requireTextMatch}
              className="w-full bg-[#0d1117] border border-wopr-border focus:border-wopr-accent rounded-lg px-3 py-2 text-sm text-wopr-text font-mono placeholder:text-wopr-textSubtle focus:outline-none"
              autoFocus
            />
          </div>
        )}

        {/* Reason Requirement */}
        {requireReason && (
          <div className="mb-5">
            <label className="block text-xs font-medium text-wopr-text mb-1.5">
              Motif de l'opération <span className="text-rose-400">*</span> :
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex: maintenance préventive, mise à jour, benchmark..."
              className="w-full bg-[#0d1117] border border-wopr-border focus:border-wopr-accent rounded-lg px-3 py-2 text-sm text-wopr-text placeholder:text-wopr-textSubtle focus:outline-none"
            />
          </div>
        )}

        {/* Countdown view during cancelable window */}
        {isCountingDown && (
          <div className="mb-5 p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-center justify-between">
            <div className="flex items-center gap-2.5 text-xs text-rose-300 font-medium">
              <Clock className="w-4 h-4 animate-spin text-rose-400" />
              <span>Exécution automatique dans <strong>{countdown} s</strong></span>
            </div>
            <button
              onClick={() => {
                setIsCountingDown(false);
                setCountdown(countdownSeconds || null);
              }}
              className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-xs font-medium rounded transition-colors"
            >
              Interrompre
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-wopr-border/50">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-xs font-medium text-wopr-textMuted hover:text-wopr-text bg-white/5 hover:bg-white/10 border border-wopr-border transition-colors"
          >
            {cancelText}
          </button>
          <button
            type="button"
            disabled={!canConfirm || isCountingDown}
            onClick={handleStartConfirmation}
            className={`px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all shadow-md ${
              isDestructive
                ? 'bg-rose-600 hover:bg-rose-500 text-white disabled:bg-rose-950/40 disabled:text-rose-400/40'
                : 'bg-wopr-accent hover:bg-wopr-accentHover text-white disabled:bg-blue-950/40 disabled:text-blue-400/40'
            } disabled:cursor-not-allowed`}
          >
            {isCountingDown ? `Action dans ${countdown}s...` : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
