import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogHeader,
  DialogOverlay, DialogPortal, DialogTitle, DialogTrigger,
  Field, FieldInput, FieldLabel,
} from '@epilot/volt-ui';
import type { Direction, Guess } from '../shared/types';
import { getPlayer, getQuote, makeGuess } from './api';
import { authClient, ensureGuestSession } from './auth';
import { quoteAgeMs, roundClock, serverNow, sessionRecovery } from './state';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const wholeNumber = new Intl.NumberFormat('en-US');
const money = (value: string) => usd.format(Number(value));
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const sessionMarker = 'btc-minute:has-session';
type SessionData = NonNullable<ReturnType<typeof authClient.useSession>['data']>;

function hadSession() {
  try { return window.localStorage.getItem(sessionMarker) === 'yes'; } catch { return false; }
}

function DirectionIcon({ direction }: { direction: Direction }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={direction === 'up' ? 'M5 16 11 10 15 14 21 6M14 6h7v7' : 'M5 8 11 14 15 10 21 18M14 18h7v-7'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Notice({ children, onRetry }: { children: React.ReactNode; onRetry?: () => void }) {
  return <div className="notice" role="alert"><span>{children}</span>{onRetry && <Button variant="ghost" size="sm" className="retry-button" onClick={onRetry}>Try again</Button>}</div>;
}

function AccountDialog({ disabled, onSuccess, restoring = false }: { disabled: boolean; onSuccess: () => Promise<unknown>; restoring?: boolean }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || disabled) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    setBusy(true);
    setError(null);
    try {
      const result = mode === 'signup'
        ? await authClient.signUp.email({ email, password, name: String(form.get('name') || '').trim() })
        : await authClient.signIn.email({ email, password, rememberMe: true });
      if (result.error) throw new Error(result.error.message || 'Could not sign in. Please try again.');
      await onSuccess();
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause, 'Could not connect. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); setError(null); } }}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" className="account-button" disabled={disabled} onClick={() => { if (restoring) setMode('signin'); }}>{restoring ? 'Sign in' : 'Save your score'}</Button>
      </DialogTrigger>
      <DialogPortal container={document.body}>
        <DialogOverlay className="account-overlay" />
        <DialogContent size="sm" className="account-dialog" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}>
          <DialogHeader>
            <DialogTitle className="dialog-title">{mode === 'signup' ? 'Keep your score.' : 'Welcome back.'}</DialogTitle>
            <DialogDescription className="dialog-description">
              {mode === 'signup' ? 'Create an account to return to your score on any device.' : 'Sign in to restore your saved score. Guest scores are not added to an existing account.'}
            </DialogDescription>
          </DialogHeader>
          <form className="account-form" onSubmit={submit}>
            {mode === 'signup' && <Field className="account-field"><FieldLabel htmlFor="account-name">Name</FieldLabel><FieldInput id="account-name" name="name" autoComplete="name" required maxLength={80} disabled={busy} /></Field>}
            <Field className="account-field"><FieldLabel htmlFor="account-email">Email</FieldLabel><FieldInput id="account-email" name="email" type="email" autoComplete="email" required maxLength={254} disabled={busy} /></Field>
            <Field className="account-field"><FieldLabel htmlFor="account-password">Password</FieldLabel><FieldInput id="account-password" name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={mode === 'signup' ? 10 : undefined} maxLength={128} required disabled={busy} aria-describedby={mode === 'signup' ? 'password-hint' : undefined} /></Field>
            {mode === 'signup' && <p id="password-hint" className="field-hint">At least 10 characters.</p>}
            {error && <Notice>{error}</Notice>}
            <Button className="submit-account" type="submit" disabled={busy || disabled}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}</Button>
          </form>
          <p className="account-toggle">{mode === 'signup' ? 'Already have an account?' : 'New here?'}{' '}<button type="button" disabled={busy} onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(null); }}>{mode === 'signup' ? 'Sign in' : 'Create an account'}</button></p>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

function LastResult({ result }: { result: Guess }) {
  const won = result.delta === 1;
  return (
    <section className={`last-result ${won ? 'result-correct' : 'result-incorrect'}`} aria-label="Last result" aria-live="polite" aria-atomic="true">
      <span className="result-symbol" aria-hidden="true">{won ? '✓' : '−'}</span>
      <div className="result-copy"><strong>{won ? 'Good call.' : 'Not this time.'} <span>{won ? '+1 point' : '−1 point'}</span></strong><p>You guessed {result.direction}. {money(result.entryPrice)} <span aria-label="to">→</span> {result.settlementPrice ? money(result.settlementPrice) : 'resolved'}</p></div>
    </section>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const { data: receivedSession, isPending: sessionPending, isRefetching: sessionRefetching, error: sessionError, refetch: refetchSession } = authClient.useSession();
  const [signedOutSessionId, setSignedOutSessionId] = useState<string | null>(null);
  // An overlapping refresh can retain a revoked session until its response arrives.
  const currentSession = receivedSession?.session.id === signedOutSessionId ? null : receivedSession;
  const [lastSession, setLastSession] = useState<SessionData | null>(null);
  const session = currentSession || lastSession;
  const [guestBusy, setGuestBusy] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [restoreExhausted, setRestoreExhausted] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const guestAttempted = useRef(false);
  const knownSession = useRef(hadSession());
  const restoreAttempts = useRef(0);
  const submitLock = useRef(false);
  const playerKey = ['player', session?.user.id] as const;

  const startGuest = useCallback(async () => {
    guestAttempted.current = true;
    setGuestBusy(true);
    setGuestError(null);
    setRestoreExhausted(false);
    try {
      await ensureGuestSession();
      knownSession.current = true;
      try { window.localStorage.setItem(sessionMarker, 'yes'); } catch { /* Cookies remain the identity source. */ }
      await refetchSession();
    } catch (cause) {
      setGuestError(errorMessage(cause, 'Your guest session could not be started.'));
    } finally { setGuestBusy(false); }
  }, [refetchSession]);

  useEffect(() => {
    // Ignore the cached session while intentional sign-out clears it.
    if (signingOut) return;
    if (currentSession) {
      setLastSession(currentSession);
      guestAttempted.current = false;
      knownSession.current = true;
      restoreAttempts.current = 0;
      setRestoreExhausted(false);
      try { window.localStorage.setItem(sessionMarker, 'yes'); } catch { /* Storage may be unavailable in private browsers. */ }
      return;
    }
    const recovery = sessionRecovery({ busy: sessionPending || sessionRefetching || signingOut || guestBusy, hasError: !!sessionError, knownSession: knownSession.current, attempts: restoreAttempts.current, exhausted: restoreExhausted, guestAttempted: guestAttempted.current });
    if (recovery.kind === 'chooseGuest') { setRestoreExhausted(true); return; }
    if (recovery.kind === 'retry') {
      const timeout = window.setTimeout(() => {
        restoreAttempts.current += 1;
        void refetchSession();
      }, recovery.delay);
      return () => window.clearTimeout(timeout);
    }
    if (recovery.kind === 'createGuest') void startGuest();
  }, [currentSession, sessionPending, sessionRefetching, sessionError, signingOut, guestBusy, restoreExhausted, startGuest, refetchSession]);

  useEffect(() => {
    const tick = window.setInterval(() => { if (visible()) setClock(Date.now()); }, 250);
    const update = () => setClock(Date.now());
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(tick); document.removeEventListener('visibilitychange', update); };
  }, []);

  const player = useQuery({
    queryKey: playerKey,
    queryFn: getPlayer,
    enabled: Boolean(currentSession) && !signingOut,
    refetchInterval: (query) => visible() ? query.state.data?.activeGuess ? 2_000 : 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const quote = useQuery({
    queryKey: ['quote'], queryFn: getQuote,
    refetchInterval: () => visible() ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const guess = useMutation({
    mutationFn: makeGuess,
    onSuccess: (state) => { queryClient.setQueryData(playerKey, state); },
    // A lost response may still have created a guess. Read authoritative state before allowing another.
    onSettled: async () => { await queryClient.invalidateQueries({ queryKey: playerKey }); },
  });

  const state = player.data;
  const active = state?.activeGuess;
  const now = serverNow(clock, state);
  const quoteAge = quoteAgeMs(quote.data?.timestamp, now);
  const stale = !Number.isFinite(quoteAge) || quoteAge > 10_000;
  const { remaining, elapsed } = roundClock(active, now);
  const connecting = sessionPending || guestBusy || !currentSession || player.isPending;
  const disabled = connecting || !!active || guess.isPending || player.isError || stale || quote.isError || signingOut;
  const isGuest = session?.user.isAnonymous ?? true;
  const canSwitchAccount = !active && !guess.isPending && (!connecting || restoreExhausted) && !signingOut;

  async function submitGuess(direction: Direction) {
    if (disabled || submitLock.current) return;
    submitLock.current = true;
    try { await guess.mutateAsync(direction); } catch { /* Displayed through mutation state. */ }
    finally { submitLock.current = false; }
  }

  async function accountChanged() {
    guess.reset();
    setAccountError(null);
    await refetchSession();
    await queryClient.invalidateQueries({ queryKey: ['player'] });
  }

  async function signOut() {
    if (!canSwitchAccount) return;
    setSigningOut(true);
    setAccountError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || 'Could not sign out.');
      setSignedOutSessionId(currentSession?.session.id ?? null);
      knownSession.current = false;
      guestAttempted.current = false;
      restoreAttempts.current = 0;
      setRestoreExhausted(false);
      setLastSession(null);
      try { window.localStorage.removeItem(sessionMarker); } catch { /* The browser cookie is still cleared. */ }
      guess.reset();
      queryClient.removeQueries({ queryKey: ['player'] });
      await refetchSession();
    } catch (cause) { setAccountError(errorMessage(cause, 'Could not sign out. Please try again.')); }
    finally { setSigningOut(false); }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#game">Skip to game</a>
      <header className="site-header">
        <a className="brand" href="/" aria-label="BTC Minute home"><span className="brand-mark" aria-hidden="true">₿</span><span>BTC<span className="brand-minute">Minute</span></span></a>
        <div className="header-actions">
          <div className={`header-quote ${stale || quote.isError ? 'header-quote-delayed' : ''}`}><span>BTC / USD{quote.data && (stale || quote.isError) ? ' (delayed)' : ''}</span><strong>{quote.data ? money(quote.data.price) : 'Loading price…'}</strong></div>
          <div className="scoreboard" aria-label={`Your score: ${state ? state.score : 'loading'}`}><span>Your score</span><strong className={state && state.score < 0 ? 'negative-score' : ''}>{state ? wholeNumber.format(state.score) : '—'}</strong><span className="points-label">pts</span></div>
          <div className="account-area">{isGuest || !currentSession ? <AccountDialog disabled={!canSwitchAccount} onSuccess={accountChanged} restoring={restoreExhausted} /> : <Button variant="ghost" size="sm" className="account-button" onClick={() => void signOut()} disabled={!canSwitchAccount}>{signingOut ? 'Signing out…' : 'Sign out'}</Button>}</div>
        </div>
      </header>

      <main id="game" className="main-content" tabIndex={-1}>
        <div className="page-heading"><h1>One minute.<br />Your call.</h1><p>Will Bitcoin go up or down?<br className="desktop-break" /> Make your prediction and see how you do.</p></div>

        {(guestError || sessionError) && <Notice onRetry={() => { guestAttempted.current = false; void (sessionError ? refetchSession() : startGuest()); }}>{guestError || 'We could not start your session. Please try again.'}</Notice>}
        {restoreExhausted && !currentSession && <div className="session-recovery"><Notice onRetry={() => { restoreAttempts.current = 0; setRestoreExhausted(false); void refetchSession(); }}>Your previous session could not be restored. Try again to reconnect to your score.</Notice><p>You can also <button type="button" onClick={() => { setLastSession(null); void startGuest(); }}>start a new guest game</button>. This will not restore your previous score.</p></div>}
        {player.isError && <Notice onRetry={() => void player.refetch()}>Your score could not be refreshed. {errorMessage(player.error, 'Please try again.')}</Notice>}
        {accountError && <Notice>{accountError}</Notice>}

        <section className="game-surface" aria-label="Bitcoin prediction game">
          <div className="market-panel">
            <div className="market-topline"><span className="market-name"><span className="bitcoin-icon" aria-hidden="true">₿</span><span><strong>Bitcoin</strong><span>BTC / USD</span></span></span><span className={`feed-status ${stale || quote.isError ? 'feed-delayed' : ''}`}><span aria-hidden="true" />{quote.isPending ? 'Connecting' : stale || quote.isError ? 'Delayed' : 'Live price'}</span></div>
            <div className="price-block"><p className="price-label">Latest price</p><p className={`market-price ${!quote.data ? 'price-loading' : ''}`}>{quote.data ? money(quote.data.price) : '—'}<span>USD</span></p><p className="price-updated">{quote.data ? Number.isFinite(quoteAge) ? `Updated ${quoteAge < 1_000 ? 'just now' : `${Math.floor(quoteAge / 1_000)}s ago`}` : 'Price timestamp unavailable' : 'Getting the latest price…'}</p></div>
            {quote.isError ? <p className="market-warning" role="status">Price updates are unavailable. Reconnecting automatically.</p> : stale && quote.data ? <p className="market-warning" role="status">Waiting for a fresh price before the next guess.</p> : <p className="market-caption">A small prediction. A sixty-second pause.</p>}
            <div className="market-baseline" aria-hidden="true"><span>Now</span><div /><span>+60 seconds</span></div>
          </div>

          <div className={`prediction-panel ${active ? 'has-prediction' : ''}`}>
            {active ? <>
              <div className="round-heading"><span className="round-label">Your prediction</span><span className="direction-badge"><DirectionIcon direction={active.direction} />{active.direction === 'up' ? 'Up' : 'Down'}</span></div>
              <div className="countdown-block"><p className="countdown" role="timer" aria-live="off" aria-label={remaining > 0 ? `${remaining} seconds remaining` : 'Waiting for a result'}>{remaining > 0 ? <><span>{String(Math.floor(remaining / 60)).padStart(2, '0')}</span><span className="countdown-colon">:</span><span>{String(remaining % 60).padStart(2, '0')}</span></> : <span className="waiting-label">Checking<br />the price…</span>}</p><p>{remaining > 0 ? 'Time until your result' : 'The round stays open if the price is unchanged.'}</p></div>
              <div className="round-progress" role="progressbar" aria-label="Prediction waiting time" aria-valuemin={0} aria-valuemax={60} aria-valuenow={60 - remaining}><span style={{ transform: `scaleX(${elapsed})` }} /></div>
              <div className="entry-price"><span>Price when you guessed</span><strong>{money(active.entryPrice)}</strong></div>
              <p className="pending-note"><ClockIcon />{remaining > 0 ? 'One guess at a time. Yours is locked in.' : 'Waiting for a fresh, changed price.'}</p>
            </> : <>
              <div className="round-heading"><h2>What’s your prediction?</h2><span className="duration"><ClockIcon />60s</span></div>
              <p className="prediction-description">Choose where the price will go after one minute.</p>
              <div className="guess-buttons"><Button variant="secondary" className="guess-button guess-up" disabled={disabled} onClick={() => void submitGuess('up')}><DirectionIcon direction="up" /><span>Up<small>Higher price</small></span></Button><Button variant="secondary" className="guess-button guess-down" disabled={disabled} onClick={() => void submitGuess('down')}><DirectionIcon direction="down" /><span>Down<small>Lower price</small></span></Button></div>
              <div className="scoring-rule"><span><span className="plus-point">+1</span> Correct guess</span><span><span className="minus-point">−1</span> Incorrect guess</span></div>
              <p className="ready-note" role="status">{guess.isPending ? 'Locking in your prediction…' : connecting ? 'Starting your game…' : player.isError ? 'Refresh your score to continue.' : stale || quote.isError ? 'Your next guess will be available when the price updates.' : 'Your guess starts the clock.'}</p>
            </>}
          </div>
        </section>

        {guess.isError && <Notice>Your last request could not be confirmed. {active ? 'Your active prediction is shown above.' : 'Your game has been refreshed; you can try again.'} {errorMessage(guess.error, '')}</Notice>}
        {state?.lastResult && !active && <LastResult result={state.lastResult} />}

        <div className="below-game"><p>{!currentSession ? 'Restoring your game…' : isGuest ? <><span className="session-dot" aria-hidden="true" />Playing as a guest. Return with this browser to keep your score.</> : <><span className="session-dot" aria-hidden="true" />Signed in{session?.user.name ? ` as ${session.user.name}` : ''}. Your score is saved.</>}</p>{active && <p>You can close this page. Your result will be here when you return.</p>}</div>
      </main>

      <footer className="site-footer"><p>Prices from <a href="https://www.coinbase.com/advanced-trade/spot/BTC-USD" target="_blank" rel="noreferrer">Coinbase</a>. A round settles using a fresh price after at least 60 seconds. If the price hasn’t changed, it waits.</p><span>Just points. No money at stake.</span></footer>
    </div>
  );
}
