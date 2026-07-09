// Single source of truth for Airtable IDs and choice names.
// All reads/writes go by field ID (returnFieldsByFieldId=true) so renaming a
// field in Airtable never breaks the pipeline. Verified against the live base
// schema on 2026-07-09.

export const BASE_ID = 'app2iq77VubxkxxzE';

export const TABLES = {
  ACCOUNTS: 'tblAgDQDxoDlZ35ZR',
  CONTACTS: 'tblZlHAFi1b1kP6IE',
  OPPORTUNITIES: 'tblLvrrW5UYBnEc94',
  TASKS: 'tblPeAd2ZZ9SLvoBf',
  ACTIVITIES: 'tblQYVUhFZV3EwC9O',
  CARRIERS: 'tblW6QC1gUQ9GQYCu',
};

export const CARRIER = {
  carrierName: 'fldiVHeJXlcHNaqsO',
  dba: 'fldH4eRGnfpG3Asd3',
  mcNumber: 'fld9UAEGbg9kZdfNM',
  dotNumber: 'fldVvz0Cn4gEpkjvH',
  status: 'fldEFIzqctxKHyenT',
  laneBatch: 'fldv20AOpPmEITeBZ',
  source: 'fldcrCOdDlqou2U0W',
  domicileCity: 'flddgsVkBe8VAIkyh',
  domicileState: 'fldH74AhuR1JGg7jA',
  phone: 'flddXwJNl8Fql8CnZ',
  email: 'fld7Wg62gMhrPdihC',
  dispatchContact: 'fldrjR4fQuImbWpaF',
  trailerTypes: 'fldaxwUzm8VNtNYe9',
  powerUnits: 'fldkhi30ynxPX5rPx',
  trucksPerWeek: 'fldne1eMSl3PBKERZ',
  coilRacks: 'fldZtmYqsAUoEchzJ',
  tarpSizes: 'fldvUnrYO2qzE697z',
  securement: 'fldtW40ZnmZZ5naRk',
  coil48k: 'fldgkEXWlBL7PB8f7',
  cargoLimit: 'fld7zWWdE8vHkpNdl',
  coilExclusion: 'fldkQn5A6a1R9sywD',
  autoLiability: 'fldPte9XncjwuEZU8',
  w9Received: 'fldvvKuhQcJfk0itJ',
  coiReceived: 'fldikjIWP2ofeCdNI',
  bcaSigned: 'fld8YnoMhMtwBUR7z',
  newMcAcceptance: 'fldycf6UCH7I4iDFY',
  paymentPreference: 'fldWizos7mDXERCbF',
  factoringCompany: 'fld4dtqWC41PKxBVU',
  rateRange: 'fldD18pYRGUDbFerF',
  coreLanes: 'fldn1Kp5BpuObIeT0',
  preferredRegions: 'flds2aFn4No0AdH47',
  deadheadRadius: 'fldgI4INk7cDTm3IV',
  dateFirstContacted: 'fldBJkGo1w0JZBXXV',
  lastContact: 'fldQ7w680K3YfhiH6',
  nextFollowUp: 'fldrJWU7nKCnREdAo',
  notes: 'fld9VP5w9vkJg6TlF',
  activities: 'fld00mPu3Oc154dnM',
};

// Phase 2 authority fields are provisioned by `verify-carriers --provision`
// and therefore have no stable IDs to pin here — they are resolved BY NAME at
// runtime via the Meta API (resolveAuthorityFields in verify-authority.js).
export const AUTHORITY_FIELD_NAMES = {
  authorityStatus: 'Authority Status',
  authorityVerifiedDate: 'Authority Verified Date',
  oosFlag: 'OOS Flag',
};

export const ACTIVITY = {
  title: 'fldN7LgJrLmliKhUY',
  activityType: 'fldWWqXtM9jnzCgqL',
  dateTime: 'fld970PWX8zC8WDQo',
  aiSummary: 'fldmtebmCdkXryOkm',
  keyDetails: 'fld56ZJLRhyczNL35',
  loggedBy: 'fldAOLCUoRMf52C5f',
  emailSubject: 'fld3Fwy5hP6ynQeyK',
  emailBody: 'fldOfIZX65ia0UC5i',
  emailStatus: 'fldXrBCGIjFIB2Aot',
  account: 'fldYcmsvzDxVHUxPL',
  carriers: 'flddo2PpX4SZqxMMO',
};

export const TASK = {
  title: 'fldtHx7a9XbRlMob7',
  taskType: 'fldtgdlgvV5GJoT1c',
  dueDate: 'fldAhiGq4Vk5ob624',
  priority: 'fld7aU3YHz8aKGTIc',
  status: 'fld5oImx0dBTeKHmi',
  instructions: 'fld81pAvssuFtHuer',
  autoCreated: 'fldEJfRysocONYjDC',
};

export const STATUS = {
  RESEARCHED: 'Researched',
  CONTACTED: 'Contacted',
  RESPONDED: 'Responded',
  VETTED: 'Vetted',
  PACKET_COMPLETE: 'Packet Complete',
  ACTIVE: 'Active',
  DECLINED: 'Declined',
  DO_NOT_USE: 'Do Not Use',
};

// Statuses in pipeline order. Automation may only ever move a carrier DOWN
// this ladder (invariant 4); Vetted and above are human-only transitions.
export const STATUS_ORDER = [
  STATUS.RESEARCHED,
  STATUS.CONTACTED,
  STATUS.RESPONDED,
  STATUS.VETTED,
  STATUS.PACKET_COMPLETE,
  STATUS.ACTIVE,
];

export const COIL_EXCLUSION = {
  CONFIRMED_NO_EXCLUSION: 'Confirmed No Exclusion',
  COILS_EXCLUDED: 'Coils Excluded',
  NOT_VERIFIED: 'Not Verified',
};

export const LANE_BATCHES = [
  'Blytheville-Atlanta (origin)',
  'Blytheville-Atlanta (dest)',
  'AL/MS Triangle',
  'Other',
];

export const SOURCE_FMCSA_CENSUS = 'FMCSA Census';

export const EMAIL_STATUS = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  OPENED: 'Opened',
  REPLIED: 'Replied',
};

export const LOGGED_BY_SYSTEM = 'System';

export const AUTHORITY_STATUS = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  NOT_FOUND: 'Not Found',
  ERROR: 'Error',
};
