// Push enrolment: permission -> FCM token -> PUT push-token -> the server sends
// a VERIFY_PUSH probe -> the donor confirms it arrived -> POST push-verified.
//
// A donor is only alertable once the server has seen that confirmation, so this
// flow is not optional decoration: every failure below has to be stated plainly
// rather than swallowed. Rendered as the one full-screen state card DESIGN.md
// specifies: the three steps stay on screen, only the action changes.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { readEnv } from '../env';
import { api, TRANSPORT_STATUS } from '../lib/api';
import { getFcmToken } from '../lib/firebase';
import { Banner, Button, Card, CheckIcon } from '../ui';

const NO_SUPPORT = 'This browser cannot receive notifications, so it cannot receive alerts.';
const DENIED =
  'Notifications are blocked for this site. Allow them in your browser settings, then try again.';
const NOT_CONFIGURED = 'Push is not configured in this build. Alerts cannot be delivered.';
const NO_TOKEN = 'This browser would not issue a push token. Alerts cannot be delivered here.';
const OFFLINE = 'You appear to be offline. Reconnect and try again.';
const SAVE_FAILED = 'Could not register this device for alerts. Try again.';
const CONFIRM_FAILED = 'Could not confirm the notification. Try again.';

const TITLE = 'Prove this phone can hear alerts';
const STEPS = [
  'Allow notifications for this site.',
  'We send one test notification.',
  'Confirm it arrived.',
];

type Step = 'idle' | 'registering' | 'sent' | 'confirming' | 'verified';

export interface PushSetupProps {
  /** Called once the server has recorded push verification. */
  onVerified: () => void;
  /** True when the page was opened by tapping the VERIFY_PUSH notification. */
  autoConfirm?: boolean;
}

function failureMessage(status: number, fallback: string): string {
  return status === TRANSPORT_STATUS ? OFFLINE : fallback;
}

export function PushSetup({ onVerified, autoConfirm = false }: PushSetupProps): ReactElement {
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const autoRan = useRef(false);

  async function confirmArrival(): Promise<void> {
    setStep('confirming');
    setError(null);
    const result = await api.confirmPushVerified();
    if (!result.ok) {
      setError(failureMessage(result.status, CONFIRM_FAILED));
      setStep('sent');
      return;
    }
    setStep('verified');
    onVerified();
  }

  useEffect(() => {
    if (!autoConfirm || autoRan.current) return;
    // The ref latches the one run; confirmArrival is stable in behaviour.
    autoRan.current = true;
    void confirmArrival();
  }, [autoConfirm]);

  async function register(): Promise<void> {
    setStep('registering');
    setError(null);

    if (typeof Notification === 'undefined') {
      setError(NO_SUPPORT);
      setStep('idle');
      return;
    }
    const permission =
      Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') {
      setError(DENIED);
      setStep('idle');
      return;
    }

    const vapidKey = readEnv('VITE_FCM_VAPID_PUBLIC_KEY');
    if (vapidKey === undefined) {
      setError(NOT_CONFIGURED);
      setStep('idle');
      return;
    }

    let token: string | null = null;
    try {
      token = await getFcmToken(vapidKey);
    } catch {
      token = null;
    }
    if (token === null) {
      setError(NO_TOKEN);
      setStep('idle');
      return;
    }

    const saved = await api.setPushToken(token);
    if (!saved.ok) {
      setError(failureMessage(saved.status, SAVE_FAILED));
      setStep('idle');
      return;
    }
    setStep('sent');
  }

  const waiting = step === 'sent' || step === 'confirming';

  return (
    <Card>
      <h3 className="push-title">{TITLE}</h3>

      <ol className="push-steps">
        {STEPS.map((text, index) => (
          <li key={text}>
            <span className="push-step-n">{String(index + 1).padStart(2, '0')}</span>
            {text}
          </li>
        ))}
      </ol>

      {step === 'verified' ? (
        <p className="ok-line">
          <CheckIcon />
          Push verified. Alerts for your blood group will reach this device.
        </p>
      ) : null}

      {step === 'idle' || step === 'registering' ? (
        <Button
          variant="primary"
          fullWidth
          loading={step === 'registering'}
          onClick={() => void register()}
        >
          Turn on alert notifications
        </Button>
      ) : null}

      {waiting ? (
        <>
          <p className="push-wait">Check your notifications. Tap the test notification, or:</p>
          <Button
            variant="primary"
            fullWidth
            loading={step === 'confirming'}
            onClick={() => void confirmArrival()}
          >
            I got it
          </Button>
        </>
      ) : null}

      {error === null ? null : <Banner tone="error">{error}</Banner>}
    </Card>
  );
}
