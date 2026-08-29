/**
 * Hausa locale — default namespace.
 * Covers the parent-facing payment flow, navigation, statuses and common
 * errors. Administrative screens fall back to English.
 */
const ha = {
  app: {
    name: "StellarEduPay",
  },

  nav: {
    payFees: "Biyan Kuɗi",
    dashboard: "Bayanan Gudanarwa",
    reports: "Rahotanni",
    fees: "Kuɗaɗe",
    feeRules: "Ƙa'idodin Kuɗaɗe",
    auditLogs: "Rijistar Bincike",
    disputes: "Rigima",
    webhooks: "Webhooks",
    sidebarAria: "Kewayawa gefe",
    section: "Kewayawa",
    language: "Harshe",
    mainNavAria: "Babban kewayawa",
    adminLogin: "Shigar Admin",
    switchToLight: "Canza zuwa haske",
    switchToDark: "Canza zuwa duhu",
    openMenu: "Buɗe menu",
    closeMenu: "Rufe menu",
    adminSection: "Admin",
  },

  actions: {
    save: "Ajiye",
    signOut: "Fita",
    saving: "Ana ajiyewa...",
    savingEllipsis: "Ana ajiyewa…",
    cancel: "Soke",
    loading: "Ana ɗauka...",
    loadMore: "Ƙara ɗauka",
    previousPage: "Shafi na baya",
    nextPage: "Shafi na gaba",
    hide: "Ɓoye",
    view: "Duba",
    viewDetails: "Duba dalla-dalla",
    viewAndResolve: "Duba kuma warware",
    collapse: "Ruɗe",
    clear: "Sake",
    copy: "Kwafi",
    copied: "An kwafa!",
    copyToClipboard: "Kwafa zuwa allunan kwafi",
    confirm: "Tabbatar",
    enable: "Kunnawa",
    verifying: "Ana tabbatarwa…",
    open: "Buɗe",
    status: "Matsayi",
    staff: "Matsayi",
  },

  time: {
    never: "Ba a taɓa",
    justNow: "Yanzu nan",
    minutesAgo: "minti {{mins}} da suka wuce",
    hoursAgo: "awa {{hrs}} da suka wuce",
    daysAgo: "kwana {{days}} da suka wuce",
    pageOf: "Shafi {{page}} na {{total}}",
  },

  status: {
    payment: {
      PENDING: "Ana jira",
      SUBMITTED: "An aiko",
      SUCCESS: "An yi nasara",
      FAILED: "An gaza",
      DISPUTED: "Shiga rigima",
      REFUNDED: "An mayar da kuɗi",
      INVALID: "Maras inganci",
      Unknown: "Ba a sani ba",
    },
    refund: {
      approval_pending: "Ana jiran amincewa",
      pending: "Ana jira",
      submitted: "An aiko",
      confirmed: "An tabbatar",
      failed: "An gaza",
    },
    dispute: {
      open: "Buɗe",
      under_review: "Ana nazari",
      resolved: "An warware",
      rejected: "An ƙi",
    },
    result: {
      success: "An yi nasara",
      failure: "An gaza",
    },
    webhook: {
      active: "Kunne",
      inactive: "Kasu",
    },
  },

  errors: {
    // Student errors
    DUPLICATE_STUDENT: "An riga an samar da ɗalibi mai wannan ID.",
    STUDENT_NOT_FOUND: "Ba a sami ɗalibin ba. Duba ID ɗin ka sake gwadawa.",
    STUDENT_ID_GENERATION_FAILED: "An kasa samar da ID na ɗalibi. Sake gwadawa.",
    STUDENT_PREVIOUSLY_DELETED: "An riga an share wannan ɗalibi kuma ba za a iya sake rajistar shi ba.",
    NO_FEE_STRUCTURE: "Ba a sami tsarin kuɗi na wannan aji ba. Saita shi tukuna.",

    // Payment errors
    SYNC_IN_PROGRESS: "An riga ana aikin daidaitawa. Jira ka sake gwadawa.",
    DUPLICATE_TX: "An riga an rubuta wannan ciniki.",
    TX_FAILED: "Ciniki ya gaza a kan hanyar sadarwar Stellar.",
    MISSING_MEMO: "Cinikin ba ya da memo ɗin ID na ɗalibi da ake buƙata.",
    INVALID_DESTINATION: "An aika ciniki zuwa adireshin walat mara kyau.",
    UNSUPPORTED_ASSET: "An biya da wani abu da ba a karɓa ba.",
    AMOUNT_TOO_LOW: "Adadin biyan ya yi ƙasa da mafi ƙaramin da aka yarda.",
    AMOUNT_TOO_HIGH: "Adadin biyan ya wuce mafi girman da aka yarda.",
    UNDERPAID: "Adadin biyan bai kai kuɗin da ake buƙata ba.",
    PAYMENT_LOCKED: "Ana sarrafa wannan biyan a yanzu. Jira.",
    INTENT_EXPIRED: "Lokacin biyan ya ƙare. Fara sake shi.",
    INVALID_FEE_CATEGORY: "An saka ajiyar kuɗi mara inganci.",

    // School errors
    DUPLICATE_SCHOOL: "An riga an samar da makaranta mai wannan suna ko slug.",
    SCHOOL_INACTIVE: "Wannan asusun makaranta bai kunnu ba.",
    MISSING_SCHOOL_CONTEXT: "Ba a sami bayanin makaranta ba. Sake shiga.",
    // Fee errors
    DUPLICATE_FEE_STRUCTURE: "An riga an samar da tsarin kuɗi na wannan aji.",
    DUPLICATE_RULE: "Wannan ƙa'idar gyara ta riga ta wanzu.",
    // Auth errors
    INVALID_CREDENTIALS: "Imel ko kalmar sirri ba daidai ba.",
    INVALID_TOKEN: "Zamaninku ba shi da inganci. Sake shiga.",
    INVALID_AUTH_TOKEN: "Zamaninku ba shi da inganci. Sake shiga.",
    INVALID_REFRESH_TOKEN: "Zamaninku ya ƙare. Sake shiga.",
    MISSING_AUTH_TOKEN: "Ana buƙatar shaidar shiga. Shiga.",
    MISSING_REFRESH_TOKEN: "Ba a sami alamar zaman ba. Sake shiga.",
    INSUFFICIENT_ROLE: "Ba ka da izinin aiwatar da wannan aikin.",
    AUTH_MISCONFIGURED: "An saka shaidar shiga ba daidai ba. Tuntuɓi tallafi.",

    // Dispute errors
    DISPUTE_ALREADY_EXISTS: "An riga an samar da rigima ga wannan ciniki.",
    INVALID_TRANSITION: "Ba za a iya matsar da wannan rigima zuwa matsayin da aka nema ba.",

    // Validation errors
    VALIDATION_ERROR: "Wasu filaye ba su da inganci. Duba abin da ka saka.",
    INVALID_AMOUNT: "Adadin da ka shigar ba shi da inganci.",
    INVALID_STELLAR_ADDRESS: "Adireshin Stellar ba shi da inganci.",
    INVALID_WEBHOOK_URL: "URL ɗin webhook ba shi da inganci.",
    INVALID_TIMEZONE: "Yankin lokaci da aka ayyana ba shi da inganci.",
    INVALID_MEMO_FORMAT: "Tsarin memo ba shi da inganci.",
    INVALID_HASH_FORMAT: "Tsarin hash na ciniki ba shi da inganci.",
    INVALID_HASH_LENGTH: "Tsawon hash na ciniki ba shi da inganci.",
    INVALID_HASH_TYPE: "Nau'in hash na ciniki ba shi da inganci.",
    INVALID_DATE_FORMAT: "Tsarin kwanan wata ba shi da inganci.",
    INVALID_SUSPICIOUS_PAYMENT_MULTIPLIER: "Ƙimar ninka biyan da ake zargi ba ta da inganci.",
    MISSING_HASH: "Ana buƙatar hash na ciniki.",
    MISSING_IDEMPOTENCY_KEY: "Ana buƙatar maɓallin idempotency ga wannan buƙatar.",
    CSV_INVALID_FORMAT: "Tsarin fayil ɗin CSV ba shi da inganci.",
    CSV_TOO_MANY_ROWS: "Fayil ɗin CSV ya ƙunshi layi da yawa.",
    CSV_TOO_LARGE: "Fayil ɗin CSV ya yi girma da yawa don aiwatarwa.",

    // Stellar / Horizon errors
    STELLAR_NETWORK_ERROR: "Hanyar sadarwar Stellar ba ta samuwa a yanzu. Sake gwadawa daga baya.",
    HORIZON_UNREACHABLE: "Hanyar sadarwar Stellar ba ta samuwa a ɗan lokaci. Duba matsayin hanyar sadarwa ka sake gwadawa daga baya.",
    HORIZON_UNAVAILABLE: "Hanyar sadarwar Stellar ba ta samuwa a ɗan lokaci. Duba matsayin hanyar sadarwa ka sake gwadawa daga baya.",
    tx_insufficient_fee: "Hanyar sadarwar Stellar ta cika kuma ta ƙi kuɗin ciniki. Sake gwadawa cikin mintuna kaɗan ko yi amfani da kuɗi mafi girma.",
    op_underfunded: "XLM bai isa ba. Ƙara XLM a walat ɗinka don ya rufe biyan da kuɗin ciniki.",

    // Rate limiting / system errors
    RATE_LIMIT_EXCEEDED: "Buƙatoci da yawa. Saukaka ɗan lokaci ka sake gwadawa.",
    IP_BLOCKED: "An toshe adireshin IP ɗinka na ɗan lokaci.",
    QUEUE_FULL: "Layin sarrafawa ya cika. Sake gwadawa nan ba da jimawa ba.",
    NOT_FOUND: "Ba a sami abin da aka nema ba.",
    INTERNAL_ERROR: "An sami kuskure mara tsammani. Sake gwadawa.",
    SERVICE_UNAVAILABLE: "Sabis ɗin ba ya samuwa na ɗan lokaci. Sake gwadawa daga baya.",
    REQUEST_TIMEOUT: "Buƙatar ta ƙare lokaci. Sake gwadawa.",
    PROCESSING_ERROR: "An sami kuskure yayin sarrafa buƙatarka.",
    MAX_RETRIES_EXCEEDED: "An wuce iyakar gwaji. Sake gwadawa daga baya.",
    CONFLICT: "An sami rikici da yanayin yanzu. Wartsake ka sake gwadawa.",
    INVALID_LOG_LEVEL: "Matsayin log ɗin da aka ayyana ba shi da inganci.",
    NO_PAYMENT_OPERATIONS: "Ba a sami ayyukan biyan kuɗi a wannan ciniki ba.",
    DEDUP_ERROR: "An gano buƙatar kwafi.",
    NETWORK_ERROR: "An sami kuskuren hanyar sadarwa. Duba haɗin kanka.",
    UNKNOWN: "An sami kuskure mara tsammani. Sake gwadawa.",
  },

  payFees: {
    howItWorksTitle: "Yadda ake aiki",
    badge: "Amintacce & Nan take",
    badgeSubtitle: "Kuɗaɗen makaranta ana biyan su a kan hanyar sadarwar Stellar",
    step1Title: "Shigar da ID ɗin ɗalibi",
    step1Desc: "Duba dalla-dallan ɗalibinka da matsayin biyan.",
    step2Title: "Aika ta Stellar",
    step2Desc: "Yi amfani da kowace walat ɗin Stellar — scan QR ko kwafa adireshi + memo.",
    step3Title: "Tabbatarwa nan take",
    step3Desc: "Ana rubuta biyanka akan blockchain cikin sakanni kaɗan.",
  },

  components: {
    testnetBanner: "TESTNET — Kada ka aika kuɗi na gaske",
  },
};

export default ha;
