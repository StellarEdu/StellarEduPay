/**
 * Tok Pisin locale — default namespace.
 * Covers the parent-facing payment flow, navigation, statuses and common
 * errors. Administrative screens fall back to English.
 */
const tpi = {
  app: {
    name: "StellarEduPay",
  },

  nav: {
    payFees: "Baim Nais",
    dashboard: "Daspot",
    reports: "Ripot",
    fees: "Nais",
    feeRules: "Rul long Nais",
    auditLogs: "Buk bilong chek",
    disputes: "Kot pati",
    webhooks: "Webhooks",
    sidebarAria: "Said long navigesen",
    section: "Navigesen",
    language: "Tokples",
    mainNavAria: "Bikpela navigesen",
    adminLogin: "Login bilong admin",
    switchToLight: "Senis long lait",
    switchToDark: "Senis long tudak",
    openMenu: "Opim menu",
    closeMenu: "Pasim menu",
    adminSection: "Admin",
  },

  actions: {
    save: "Sivim",
    signOut: "Autsait",
    saving: "Sivim nau...",
    savingEllipsis: "Sivim nau…",
    cancel: "Rausim",
    loading: "Kisim nau...",
    loadMore: "Kisim moa",
    previousPage: "Pes bilong bipo",
    nextPage: "Nekis pes",
    hide: "Haitim",
    view: "Lukim",
    viewDetails: "Lukim ol detal",
    viewAndResolve: "Lukim na stretim",
    collapse: "Haitim",
    clear: "Klinim",
    copy: "Kopi",
    copied: "Kopi pinis!",
    copyToClipboard: "Kopi long klipbod",
    confirm: "Truim",
    enable: "Opim",
    verifying: "Chekim…",
    open: "Op",
    status: "Sisim",
    staff: "Sisim",
  },

  time: {
    never: "Neva",
    justNow: "Nau tasol",
    minutesAgo: "{{mins}} min i pinis",
    hoursAgo: "{{hrs}} aua i pinis",
    daysAgo: "{{days}} de i pinis",
    pageOf: "Pes {{page}} bilong {{total}}",
  },

  status: {
    payment: {
      PENDING: "I wetim",
      SUBMITTED: "Salim pinis",
      SUCCESS: "Wanpela",
      FAILED: "Pundaun",
      DISPUTED: "Kot pati",
      REFUNDED: "Bekim pinis",
      INVALID: "No stret",
      Unknown: "No save",
    },
    refund: {
      approval_pending: "I wetim orai",
      pending: "I wetim",
      submitted: "Salim pinis",
      confirmed: "Truim pinis",
      failed: "Pundaun",
    },
    dispute: {
      open: "Op",
      under_review: "Lukluk i go",
      resolved: "Stret pinis",
      rejected: "Raus pinis",
    },
    result: {
      success: "Wanpela",
      failure: "Pundaun",
    },
    webhook: {
      active: "Aktif",
      inactive: "No aktif",
    },
  },

  errors: {
    // Student errors
    DUPLICATE_STUDENT: "Wanpela estudiante i gat dispela ID pinis.",
    STUDENT_NOT_FOUND: "No painim estudiante. Lukim ID na trai gen.",
    STUDENT_ID_GENERATION_FAILED: "Inap long kamapim ID bilong estudiante. Trai gen.",
    STUDENT_PREVIOUSLY_DELETED: "Dispela estudiante i bin raus pinis na inap long rejista gen.",
    NO_FEE_STRUCTURE: "No painim nais long dispela klas. Putim mak nau tasol.",

    // Payment errors
    SYNC_IN_PROGRESS: "Wanpela sink i wok nau. Wet liklik na trai gen.",
    DUPLICATE_TX: "Dispela transkesen i wanpela wok em bipo.",
    TX_FAILED: "Transkesen i pundaun long Stellar netwok.",
    MISSING_MEMO: "Transkesen i no gat memo bilong ID bilong estudiante.",
    INVALID_DESTINATION: "Transkesen i go long rong adres bilong woket.",
    UNSUPPORTED_ASSET: "Pei i kam long wanpela bisnis i no sapotim.",
    AMOUNT_TOO_LOW: "Pei i liklik moa long minimum.",
    AMOUNT_TOO_HIGH: "Pei i bikpela moa long maksimem.",
    UNDERPAID: "Pei i liklik moa long nais.",
    PAYMENT_LOCKED: "Dispela pei i wok nau. Wet liklik.",
    INTENT_EXPIRED: "Sesen bilong pei i pinis. Stat gen.",
    INVALID_FEE_CATEGORY: "Kategori bilong nais i no stret.",

    // School errors
    DUPLICATE_SCHOOL: "Wanpela skul i gat dispela nem pinis.",
    SCHOOL_INACTIVE: "Dispela akaut bilong skul i slip.",
    MISSING_SCHOOL_CONTEXT: "Kontekst bilong skul i kamap long luksave. Login gen.",

    // Fee errors
    DUPLICATE_FEE_STRUCTURE: "Nais bilong dispela klas i stap pinis.",
    DUPLICATE_RULE: "Dispela rul i stap pinis.",

    // Auth errors
    INVALID_CREDENTIALS: "Imel o paswod i rong.",
    INVALID_TOKEN: "Sesen bilong yu i no stret. Login gen.",
    INVALID_AUTH_TOKEN: "Sesen bilong yu i no stret. Login gen.",
    INVALID_REFRESH_TOKEN: "Sesen bilong yu i pinis. Login gen.",
    MISSING_AUTH_TOKEN: "Autentikesen i nidim. Login.",
    MISSING_REFRESH_TOKEN: "Token bilong sesen i stap long lukim. Login gen.",
    INSUFFICIENT_ROLE: "Yu no gat permisen long mekim dispela.",
    AUTH_MISCONFIGURED: "Autentikesen i no stret tambu. Askim help.",

    // Dispute errors
    DISPUTE_ALREADY_EXISTS: "Kot pati bilong dispela transkesen i stap pinis.",
    INVALID_TRANSITION: "Kot pati i inap long go long dispela sisim.",

    // Validation errors
    VALIDATION_ERROR: "Sampela ples i no stret. Lukim gut ol samting yu putim.",
    INVALID_AMOUNT: "Namba yu putim i no stret.",
    INVALID_STELLAR_ADDRESS: "Adres bilong Stellar i no stret.",
    INVALID_WEBHOOK_URL: "URL bilong webhook i no stret.",
    INVALID_TIMEZONE: "Taim zon i no stret.",
    INVALID_MEMO_FORMAT: "Memoo format i no stret.",
    INVALID_HASH_FORMAT: "HAS format i no stret.",
    INVALID_HASH_LENGTH: "HAS i no long wanem nes.",
    INVALID_HASH_TYPE: "HAS tip i no stret.",
    INVALID_DATE_FORMAT: "De format i no stret.",
    INVALID_SUSPICIOUS_PAYMENT_MULTIPLIER: "Namba bilong suspekt pei i no stret.",
    MISSING_HASH: "HAS bilong transkesen i nidim.",
    MISSING_IDEMPOTENCY_KEY: "Ki bilong idempotens olgeta asken.",
    CSV_INVALID_FORMAT: "Format bilong CSV fail i no stret.",
    CSV_TOO_MANY_ROWS: "CSV fail i gat planti ro.",
    CSV_TOO_LARGE: "CSV fail i bikpela tumas long prosesim.",

    // Stellar / Horizon errors
    STELLAR_NETWORK_ERROR: "Stellar netwok i no stap nau. Trai gen bihain.",
    HORIZON_UNREACHABLE: "Stellar netwok i no stap nau. Lukim sisim na trai gen bihain.",
    HORIZON_UNAVAILABLE: "Stellar netwok i no stap nau. Lukim sisim na trai gen bihain.",
    tx_insufficient_fee: "Stellar netwok i pen na i no hetim nais. Trai gen long sampela minit o usim bikpela nais.",
    op_underfunded: "XLM i no inap. Putim XLM long woket bilong yu long kavremap nais.",

    // Rate limiting / system errors
    RATE_LIMIT_EXCEEDED: "Planti asken tumas. I no ken haku. Trai gen.",
    IP_BLOCKED: "Yu paia. IP bilong yu i ben banim nau.",
    QUEUE_FULL: "Kiau bilong proses i pulap. Trai gen bihain.",
    NOT_FOUND: "No painim dispela samting.",
    INTERNAL_ERROR: "Wanpela samting i no stret. Trai gen.",
    SERVICE_UNAVAILABLE: "Service i no stap nau. Trai gen bihain.",
    REQUEST_TIMEOUT: "Asken i pundaun long taim. Trai gen.",
    PROCESSING_ERROR: "Wanpela samting i pundaun long prosesim asken bilong yu.",
    MAX_RETRIES_EXCEEDED: "Planti trai tumas. Trai gen bihain.",
    CONFLICT: "Konflik i kamap. Riloim pes na trai gen.",
    INVALID_LOG_LEVEL: "Lebel bilong log i no stret.",
    NO_PAYMENT_OPERATIONS: "No painim pei wenkop long dispela transkesen.",
    DEDUP_ERROR: "Wanpela dupiliket asken i kamap.",
    NETWORK_ERROR: "Netwok i pundaun. Lukim konneksen bilong yu.",
    UNKNOWN: "Wanpela samting i no stret. Trai gen.",
  },

  payFees: {
    howItWorksTitle: "Olsem wanem em i wok",
    badge: "Seif & Kwik",
    badgeSubtitle: "Nais bilong skul i go long Stellar netwok",
    step1Title: "Putim ID bilong estudiante",
    step1Desc: "Lukim ol detail bilong estudiante na sisim bilong pei.",
    step2Title: "Salim long Stellar",
    step2Desc: "Yusim wanpela Stellar woket — klinim QR o kopi adres + memo.",
    step3Title: "Kwik konfirmesen",
    step3Desc: "Pei bilong yu i go long blokchain insait long sampela sekon.",
  },

  components: {
    testnetBanner: "TESTNET — No salim manimani tru",
  },
};

export default tpi;
