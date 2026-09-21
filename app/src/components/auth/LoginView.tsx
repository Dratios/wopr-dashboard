import React, { useEffect, useRef, useState } from 'react';
import { Lock, LoaderCircle, ShieldAlert, Terminal } from 'lucide-react';
import { store } from '../../state/store';
import { ApiError } from '../../state/api';

/**
 * Écran de connexion.
 *
 * Le dashboard peut arrêter des conteneurs, tuer des processus et redémarrer la
 * machine : il n'expose rien avant authentification. Un seul compte
 * administrateur existe, dont l'empreinte scrypt vit dans le `.env` du stack.
 */
export const LoginView: React.FC = () => {
  // Un seul compte existe : on le pré-remplit pour que la connexion se résume
  // à saisir le mot de passe.
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await store.login(username.trim(), password);
      // Le rendu bascule tout seul : `currentUser` change dans le store.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Connexion impossible');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-wopr-bg flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-11 h-11 rounded-lg bg-wopr-accent/10 border border-wopr-accent/30
                          flex items-center justify-center">
            <Terminal size={22} className="text-wopr-accent" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-wopr-text tracking-tight">wopr</h1>
            <p className="text-xs text-wopr-textMuted">Supervision du serveur</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="bg-wopr-surface border border-wopr-border rounded-xl p-6 space-y-4"
        >
          <div>
            <label htmlFor="username"
                   className="block text-xs font-medium text-wopr-textMuted mb-1.5">
              Administrateur
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full bg-wopr-bg border border-wopr-border rounded-lg px-3 py-2
                         text-sm text-wopr-text placeholder:text-wopr-textSubtle
                         focus:outline-none focus:border-wopr-accent
                         focus:ring-1 focus:ring-wopr-accent transition-colors"
              placeholder="admin"
            />
          </div>

          <div>
            <label htmlFor="password"
                   className="block text-xs font-medium text-wopr-textMuted mb-1.5">
              Mot de passe
            </label>
            <input
              id="password"
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full bg-wopr-bg border border-wopr-border rounded-lg px-3 py-2
                         text-sm text-wopr-text placeholder:text-wopr-textSubtle
                         focus:outline-none focus:border-wopr-accent
                         focus:ring-1 focus:ring-wopr-accent transition-colors"
              placeholder="••••••••••"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 text-xs text-wopr-err bg-wopr-err/10
                         border border-wopr-err/30 rounded-lg px-3 py-2"
            >
              <ShieldAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !username.trim() || !password}
            className="w-full flex items-center justify-center gap-2 bg-wopr-accent
                       hover:bg-wopr-accentHover disabled:opacity-40
                       disabled:cursor-not-allowed text-white text-sm font-medium
                       rounded-lg px-4 py-2.5 transition-colors"
          >
            {busy ? (
              <>
                <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                Vérification…
              </>
            ) : (
              <>
                <Lock size={15} aria-hidden="true" />
                Se connecter
              </>
            )}
          </button>
        </form>

        <p className="text-[11px] text-wopr-textSubtle text-center mt-5 leading-relaxed">
          Accès réservé au réseau local.<br />
          Chaque action effectuée depuis cette interface est journalisée.
        </p>
      </div>
    </div>
  );
};
