// Wire contracts for every server endpoint, mirrored from the server route
// modules (server/src/routes/*.ts). This file is types only — no runtime
// behaviour — so the API client and the UI share one vocabulary.
//
// Enum vocabularies are copied from the server's single sources:
//   BloodGroup   -> server/src/matching/compatibility.ts (BLOOD_GROUPS)
//   RequestState -> server/src/domain/requestFsm.ts
//   PledgeState  -> server/src/domain/pledgeFsm.ts
//   Urgency/Eta  -> routes/requests.ts, routes/pledgesShared.ts
// The client never computes eligibility or state transitions from them; they
// exist so a typo becomes a compile error.

export const BLOOD_GROUPS = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export const URGENCIES = ['critical', 'standard'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const ETA_BUCKETS = ['le_30m', 'le_1h', 'le_2h'] as const;
export type EtaBucket = (typeof ETA_BUCKETS)[number];

export type RequestState =
  | 'open'
  | 'alerting'
  | 'partially_pledged'
  | 'covered'
  | 'fulfilled'
  | 'expired'
  | 'cancelled';

export type PledgeState = 'active' | 'donated' | 'withdrawn' | 'no_show' | 'released';

// ── Donor ────────────────────────────────────────────────────────────────────

/** POST /donors — `consent` must be the literal true (no silent opt-in). */
export interface RegisterDonorInput {
  handle: string;
  bloodGroup: BloodGroup;
  /** geohash-5 cell, truncated ON DEVICE. Exact GPS never leaves the browser. */
  geohash5: string;
  consent: true;
}

export interface DonorRegistration {
  donorId: string;
  handle: string;
  bloodGroup: BloodGroup;
  geohash5: string;
  tz: string;
}

/**
 * The pledge this donor is currently holding, echoed on GET /donors/me so the
 * donor screen can always offer a way back to the directions. Donors hold one
 * pledge at a time, so this is one row or nothing.
 */
export interface ActivePledge {
  pledgeId: string;
  /**
   * The alert to reopen — /alerts/<alertId> is where the directions live. Null
   * when the pledge has no dispatch row behind it, which is the one case the
   * donor cannot be routed back to a screen.
   */
  alertId: string | null;
  requestState: RequestState;
}

/** GET/PATCH /donors/me — the only donor shape the server emits. */
export interface DonorView {
  donorId: string;
  handle: string;
  bloodGroup: BloodGroup;
  geohash5: string;
  tz: string;
  optedIn: boolean;
  available: boolean;
  snoozeUntil: string | null;
  sharePhoneOnAccept: boolean;
  pushVerified: boolean;
  lastDonationAt: string | null;
  activePledge: ActivePledge | null;
}

/** PATCH /donors/me — every field optional; snoozeUntil accepts explicit null. */
export interface DonorPatchInput {
  handle?: string;
  available?: boolean;
  optedIn?: boolean;
  snoozeUntil?: string | null;
  sharePhoneOnAccept?: boolean;
  geohash5?: string;
  bloodGroup?: BloodGroup;
}

export interface PushTokenAccepted {
  verificationSent: true;
}

export interface PushVerified {
  pushVerified: true;
}

/** POST /donors/me/donations — omit donatedAt to mean "now". */
export interface ReportDonationInput {
  donatedAt?: string;
}

export interface DonationReported {
  lastDonationAt: string | null;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export interface CreateRequestInput {
  bloodGroup: BloodGroup;
  unitsNeeded: number;
  urgency: Urgency;
  hospitalId: string;
  /** Skips same-requester dedupe when a second patient genuinely needs the same group. */
  differentPatient?: boolean;
}

export interface RequestCreated {
  requestId: string;
  state: RequestState;
  expiresAt: string;
  /** Soft advisory only ('similar_open_request_exists'); never blocks. */
  warning?: string;
}

/** GET /requests/mine — aggregates only; the requester never sees a donor roster. */
export interface RequestSummary {
  requestId: string;
  bloodGroup: BloodGroup;
  unitsNeeded: number;
  unitsConfirmed: number;
  urgency: Urgency;
  state: RequestState;
  radiusTier: number;
  hospitalId: string;
  createdAt: string;
  expiresAt: string;
  donorsAlerted: number;
  activePledges: number;
}

export interface RequestHospital {
  name: string;
  address: string;
  bloodbankPhone: string;
}

/** Pledge snapshot columns — written at accept, never a live donor join. */
export interface PledgeCard {
  pledgeId: string;
  donorHandle: string;
  donorBloodGroup: BloodGroup;
  donorPhone: string | null;
  etaBucket: EtaBucket;
  state: PledgeState;
  createdAt: string;
}

export interface RequestDetail extends RequestSummary {
  hospital: RequestHospital;
  pledges: PledgeCard[];
}

// ── Alerts + pledges (donor side) ────────────────────────────────────────────

export interface AlertHospital {
  name: string;
  address: string;
  lat: number;
  lng: number;
  bloodbankPhone: string;
}

/**
 * The reading donor's own pledge on this alert, or null when they have not
 * accepted. It is what makes the pledged screen survive a reload: the client
 * holds no memory of an accept, the server does.
 */
export interface AlertPledge {
  pledgeId: string;
  state: PledgeState;
  etaBucket: EtaBucket;
}

/** GET /alerts/:alertId — fetch-on-tap detail; the push itself carries no content. */
export interface AlertDetail {
  alertId: string;
  bloodGroup: BloodGroup;
  unitsNeeded: number;
  urgency: Urgency;
  requestState: RequestState;
  hospital: AlertHospital;
  distanceKm: number;
  createdAt: string;
  expiresAt: string;
  pledge: AlertPledge | null;
}

export interface AcceptAlertInput {
  etaBucket: EtaBucket;
  /** Sets the donor's share-phone toggle as part of the accept (DECISIONS #4). */
  sharePhone?: boolean;
}

export interface AcceptHospital {
  name: string;
  lat: number;
  lng: number;
  bloodbankPhone: string;
}

export interface PledgeAccepted {
  pledgeId: string;
  requestState: RequestState;
  hospital: AcceptHospital;
  directionsUrl: string;
}

// ── Fulfillment ──────────────────────────────────────────────────────────────

export interface PledgeDonated {
  pledgeState: PledgeState;
  requestState: RequestState;
  unitsConfirmed: number;
}

export interface PledgeReleased {
  pledgeState: PledgeState;
  requestState: RequestState;
}

export interface RequestCancelled {
  requestState: RequestState;
  pledgesReleased: number;
}
