// The donor surface. Pages import from here, never from the files directly, so
// the donor screen set stays visible in one place — and so donor.css is loaded
// exactly once, by whichever donor route mounts first.
import './donor.css';

export { AlertActions, type AlertAction, type AlertActionsProps } from './AlertActions';
export { AlertFacts } from './AlertFacts';
export { AlertState, type AlertStateProps } from './AlertState';
export {
  closedCopy,
  ETA_LABELS,
  ETA_SHORT,
  expiresLabel,
  isAcceptable,
  pledgeCopy,
  URGENCY_LABELS,
  urgencyTone,
  type ClosedCopy,
  type ClosedPledgeState,
} from './alertCopy';
export { DonorActivePledgeCard } from './DonorActivePledgeCard';
export { DonorDonationCard, type DonorDonationCardProps } from './DonorDonationCard';
export { DonorIdentityCard } from './DonorIdentityCard';
export { DonorSettings, type DonorSettingsProps } from './DonorSettings';
export { Onboarding, type OnboardingProps } from './Onboarding';
export { PledgeResult, type PledgeResultProps } from './PledgeResult';
export { PushSetup, type PushSetupProps } from './PushSetup';
