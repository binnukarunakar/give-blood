// Phone-OTP sign-in. Two steps: send an SMS code, then confirm it. Firebase is
// touched only on submit, so this route renders without a configured project.
import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '../auth/authContext';
import {
  confirmPhoneCode,
  createRecaptchaVerifier,
  startPhoneSignIn,
  type ConfirmationResult,
  type RecaptchaVerifier,
} from '../lib/firebase';
import { Banner, Button, Card, DropMark, Field } from '../ui';

const RECAPTCHA_CONTAINER_ID = 'recaptcha-container';
const SEND_FAILED = 'Could not send the code. Check the number and try again.';
const CONFIRM_FAILED = 'That code was not accepted. Request a new one and try again.';

export function Login(): ReactElement {
  const { status } = useAuth();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verifierRef = useRef<RecaptchaVerifier | null>(null);

  if (status === 'signed-in') {
    return <Navigate to="/donor" replace />;
  }

  async function handleSend(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // A spent verifier cannot be reused — clear the previous one before retrying.
    verifierRef.current?.clear();
    try {
      const verifier = createRecaptchaVerifier(RECAPTCHA_CONTAINER_ID);
      verifierRef.current = verifier;
      setConfirmation(await startPhoneSignIn(phone, verifier));
    } catch {
      setError(SEND_FAILED);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (confirmation === null) return;
    setBusy(true);
    setError(null);
    try {
      await confirmPhoneCode(confirmation, code);
    } catch {
      setError(CONFIRM_FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="login">
      <div className="login-card">
        <Card>
          <span className="login-mark">
            <DropMark size={32} />
          </span>
          <h2 className="login-title">Sign in to Give Blood</h2>
          <p className="login-lede">
            Your phone number is your donor identity. We send a one-time code by SMS.
          </p>

          {confirmation === null ? (
            <form className="login-form" onSubmit={(event) => void handleSend(event)}>
              <Field
                id="phone"
                name="phone"
                label="Phone number, with country code"
                type="tel"
                autoComplete="tel"
                inputMode="tel"
                placeholder="+15551234567"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                required
              />
              <Button
                type="submit"
                variant="primary"
                fullWidth
                loading={busy}
                disabled={phone === ''}
              >
                Send code
              </Button>
            </form>
          ) : (
            <form className="login-form" onSubmit={(event) => void handleConfirm(event)}>
              <Field
                id="code"
                name="code"
                label="Six-digit code"
                helper={`Sent by SMS to ${phone}.`}
                type="text"
                autoComplete="one-time-code"
                inputMode="numeric"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
              <Button
                type="submit"
                variant="primary"
                fullWidth
                loading={busy}
                disabled={code === ''}
              >
                Verify code
              </Button>
            </form>
          )}

          {error === null ? null : <Banner tone="error">{error}</Banner>}
        </Card>
      </div>
      <div id={RECAPTCHA_CONTAINER_ID} />
    </section>
  );
}
