/**
 * Spanish locale — default namespace.
 * Covers the parent-facing payment flow, navigation, statuses and common
 * errors. Administrative screens fall back to English.
 */
const es = {
  app: {
    name: "StellarEduPay",
  },

  nav: {
    payFees: "Pagar cuotas",
    dashboard: "Panel",
    reports: "Informes",
    fees: "Cuotas",
    feeRules: "Reglas de cuotas",
    auditLogs: "Registros de auditoría",
    disputes: "Disputas",
    webhooks: "Webhooks",
    sidebarAria: "Navegación lateral",
    section: "Navegación",
    language: "Idioma",
    mainNavAria: "Navegación principal",
    adminLogin: "Acceso de administrador",
    switchToLight: "Cambiar a modo claro",
    switchToDark: "Cambiar a modo oscuro",
    openMenu: "Abrir menú",
    closeMenu: "Cerrar menú",
    adminSection: "Administrador",
  },

  actions: {
    save: "Guardar",
    signOut: "Cerrar sesión",
    saving: "Guardando...",
    savingEllipsis: "Guardando…",
    cancel: "Cancelar",
    loading: "Cargando...",
    loadMore: "Cargar más",
    previousPage: "Página anterior",
    nextPage: "Página siguiente",
    hide: "Ocultar",
    view: "Ver",
    viewDetails: "Ver detalles",
    viewAndResolve: "Ver y resolver",
    collapse: "Contraer",
    clear: "Limpiar",
    copy: "Copiar",
    copied: "¡Copiado!",
    copyToClipboard: "Copiar al portapapeles",
    confirm: "Confirmar",
    enable: "Activar",
    verifying: "Verificando…",
    open: "Abrir",
    status: "Estado",
    staff: "Estado",
  },

  time: {
    never: "Nunca",
    justNow: "Ahora mismo",
    minutesAgo: "hace {{mins}} min",
    hoursAgo: "hace {{hrs}} h",
    daysAgo: "hace {{days}} d",
    pageOf: "Página {{page}} de {{total}}",
  },

  status: {
    payment: {
      PENDING: "Pendiente",
      SUBMITTED: "Enviado",
      SUCCESS: "Exitoso",
      FAILED: "Fallido",
      DISPUTED: "En disputa",
      REFUNDED: "Reembolsado",
      INVALID: "Inválido",
      Unknown: "Desconocido",
    },
    refund: {
      approval_pending: "En espera de aprobación",
      pending: "Pendiente",
      submitted: "Enviado",
      confirmed: "Confirmado",
      failed: "Fallido",
    },
    dispute: {
      open: "Abierta",
      under_review: "En revisión",
      resolved: "Resuelta",
      rejected: "Rechazada",
    },
    result: {
      success: "Exitoso",
      failure: "Fallo",
    },
    webhook: {
      active: "Activo",
      inactive: "Inactivo",
    },
  },

  errors: {
    // Student errors
    DUPLICATE_STUDENT: "Ya existe un estudiante con este ID.",
    STUDENT_NOT_FOUND: "Estudiante no encontrado. Verifique el ID e intente de nuevo.",
    STUDENT_ID_GENERATION_FAILED: "No se pudo generar un ID de estudiante. Intente de nuevo.",
    STUDENT_PREVIOUSLY_DELETED: "Este estudiante fue eliminado anteriormente y no puede ser re-registrado.",
    NO_FEE_STRUCTURE: "No se encontró una estructura de cuotas para esta clase. Configúrela primero.",

    // Payment errors
    SYNC_IN_PROGRESS: "Ya hay una sincronización en curso. Espere e intente de nuevo.",
    DUPLICATE_TX: "Esta transacción ya fue registrada.",
    TX_FAILED: "La transacción falló en la red Stellar.",
    MISSING_MEMO: "La transacción no incluye el memo del ID de estudiante requerido.",
    INVALID_DESTINATION: "La transacción se envió a la dirección de billetera incorrecta.",
    UNSUPPORTED_ASSET: "El pago se realizó en un activo no compatible.",
    AMOUNT_TOO_LOW: "El monto del pago está por debajo del mínimo permitido.",
    AMOUNT_TOO_HIGH: "El monto del pago supera el máximo permitido.",
    UNDERPAID: "El monto del pago es menor que la cuota requerida.",
    PAYMENT_LOCKED: "Este pago está siendo procesado. Espere.",
    INTENT_EXPIRED: "La sesión de pago ha expirado. Comience de nuevo.",
    INVALID_FEE_CATEGORY: "Categoría de cuota no válida.",

    // School errors
    DUPLICATE_SCHOOL: "Ya existe una escuela con este nombre o slug.",
    SCHOOL_INACTIVE: "Esta cuenta de escuela está inactiva.",
    MISSING_SCHOOL_CONTEXT: "Falta el contexto de la escuela. Inicie sesión de nuevo.",

    // Fee errors
    DUPLICATE_FEE_STRUCTURE: "Ya existe una estructura de cuotas para esta clase.",
    DUPLICATE_RULE: "Esta regla de ajuste ya existe.",

    // Auth errors
    INVALID_CREDENTIALS: "Correo electrónico o contraseña incorrectos.",
    INVALID_TOKEN: "Su sesión no es válida. Inicie sesión de nuevo.",
    INVALID_AUTH_TOKEN: "Su sesión no es válida. Inicie sesión de nuevo.",
    INVALID_REFRESH_TOKEN: "Su sesión ha expirado. Inicie sesión de nuevo.",
    MISSING_AUTH_TOKEN: "Se requiere autenticación. Inicie sesión.",
    MISSING_REFRESH_TOKEN: "Falta el token de sesión. Inicie sesión de nuevo.",
    INSUFFICIENT_ROLE: "No tiene permiso para realizar esta acción.",
    AUTH_MISCONFIGURED: "La autenticación está mal configurada. Contacte al soporte.",

    // Dispute errors
    DISPUTE_ALREADY_EXISTS: "Ya existe una disputa para esta transacción.",
    INVALID_TRANSITION: "Esta disputa no puede moverse al estado solicitado.",

    // Validation errors
    VALIDATION_ERROR: "Algunos campos no son válidos. Revise su entrada.",
    INVALID_AMOUNT: "El monto ingresado no es válido.",
    INVALID_STELLAR_ADDRESS: "La dirección Stellar no es válida.",
    INVALID_WEBHOOK_URL: "La URL del webhook no es válida.",
    INVALID_TIMEZONE: "La zona horaria especificada no es válida.",
    INVALID_MEMO_FORMAT: "El formato del memo no es válido.",
    INVALID_HASH_FORMAT: "El formato del hash de transacción no es válido.",
    INVALID_HASH_LENGTH: "La longitud del hash de transacción no es válida.",
    INVALID_HASH_TYPE: "El tipo de hash de transacción no es válido.",
    INVALID_DATE_FORMAT: "El formato de fecha no es válido.",
    INVALID_SUSPICIOUS_PAYMENT_MULTIPLIER: "El valor del multiplicador de pago sospechoso no es válido.",
    MISSING_HASH: "Se requiere un hash de transacción.",
    MISSING_IDEMPOTENCY_KEY: "Se requiere una clave de idempotencia para esta solicitud.",
    CSV_INVALID_FORMAT: "El formato del archivo CSV no es válido.",
    CSV_TOO_MANY_ROWS: "El archivo CSV contiene demasiadas filas.",
    CSV_TOO_LARGE: "El archivo CSV es demasiado grande para procesarlo.",

    // Stellar / Horizon errors
    STELLAR_NETWORK_ERROR: "La red Stellar no está disponible actualmente. Intente de nuevo más tarde.",
    HORIZON_UNREACHABLE: "La red Stellar está temporalmente no disponible. Verifique el estado de la red e intente de nuevo más tarde.",
    HORIZON_UNAVAILABLE: "La red Stellar está temporalmente no disponible. Verifique el estado de la red e intente de nuevo más tarde.",
    tx_insufficient_fee: "La red Stellar está congestionada y rechazó la tarifa de transacción. Intente de nuevo en unos minutos o use una tarifa más alta.",
    op_underfunded: "Saldo XLM insuficiente. Recargue su billetera con suficiente XLM para cubrir el pago y la tarifa de transacción.",

    // Rate limiting / system errors
    RATE_LIMIT_EXCEEDED: "Demasiadas solicitudes. Reduzca la velocidad e intente de nuevo.",
    IP_BLOCKED: "Su dirección IP ha sido bloqueada temporalmente.",
    QUEUE_FULL: "La cola de procesamiento está llena. Intente de nuevo en breve.",
    NOT_FOUND: "El recurso solicitado no fue encontrado.",
    INTERNAL_ERROR: "Ocurrió un error inesperado. Intente de nuevo.",
    SERVICE_UNAVAILABLE: "El servicio está temporalmente no disponible. Intente de nuevo más tarde.",
    REQUEST_TIMEOUT: "La solicitud agotó el tiempo. Intente de nuevo.",
    PROCESSING_ERROR: "Ocurrió un error al procesar su solicitud.",
    MAX_RETRIES_EXCEEDED: "Se superó el máximo de reintentos. Intente de nuevo más tarde.",
    CONFLICT: "Ocurrió un conflicto con el estado actual. Actualice e intente de nuevo.",
    INVALID_LOG_LEVEL: "El nivel de registro especificado no es válido.",
    NO_PAYMENT_OPERATIONS: "No se encontraron operaciones de pago en esta transacción.",
    DEDUP_ERROR: "Se detectó una solicitud duplicada.",
    NETWORK_ERROR: "Ocurrió un error de red. Verifique su conexión.",
    UNKNOWN: "Ocurrió un error inesperado. Intente de nuevo.",
  },

  payFees: {
    howItWorksTitle: "Cómo funciona",
    badge: "Seguro e Instantáneo",
    badgeSubtitle: "Cuotas escolares pagadas en la red Stellar",
    step1Title: "Ingrese el ID del estudiante",
    step1Desc: "Consulte los detalles de su estudiante y el estado del pago.",
    step2Title: "Envíe vía Stellar",
    step2Desc: "Use cualquier billetera Stellar: escanee el QR o copie la dirección + memo.",
    step3Title: "Confirmación instantánea",
    step3Desc: "Su pago se registra en cadena en segundos.",
  },

  components: {
    testnetBanner: "TESTNET — No envíe fondos reales",
  },
};

export default es;
