/**
 * Portuguese locale — default namespace.
 * Covers the parent-facing payment flow, navigation, statuses and common
 * errors. Administrative screens fall back to English.
 */
const pt = {
  app: {
    name: "StellarEduPay",
  },

  nav: {
    payFees: "Pagar mensalidades",
    dashboard: "Painel",
    reports: "Relatórios",
    fees: "Mensalidades",
    feeRules: "Regras de mensalidades",
    auditLogs: "Registros de auditoria",
    disputes: "Disputas",
    webhooks: "Webhooks",
    sidebarAria: "Navegação lateral",
    section: "Navegação",
    language: "Idioma",
    mainNavAria: "Navegação principal",
    adminLogin: "Login de administrador",
    switchToLight: "Mudar para o modo claro",
    switchToDark: "Mudar para o modo escuro",
    openMenu: "Abrir menu",
    closeMenu: "Fechar menu",
    adminSection: "Administração",
  },

  actions: {
    save: "Salvar",
    signOut: "Sair",
    saving: "Salvando...",
    savingEllipsis: "Salvando…",
    cancel: "Cancelar",
    loading: "Carregando...",
    loadMore: "Carregar mais",
    previousPage: "Página anterior",
    nextPage: "Próxima página",
    hide: "Ocultar",
    view: "Ver",
    viewDetails: "Ver detalhes",
    viewAndResolve: "Ver e resolver",
    collapse: "Recolher",
    clear: "Limpar",
    copy: "Copiar",
    copied: "Copiado!",
    copyToClipboard: "Copiar para a área de transferência",
    confirm: "Confirmar",
    enable: "Ativar",
    verifying: "Verificando…",
    open: "Abrir",
    status: "Status",
    staff: "Status",
  },

  time: {
    never: "Nunca",
    justNow: "Agora mesmo",
    minutesAgo: "há {{mins}} min",
    hoursAgo: "há {{hrs}} h",
    daysAgo: "há {{days}} d",
    pageOf: "Página {{page}} de {{total}}",
  },

  status: {
    payment: {
      PENDING: "Pendente",
      SUBMITTED: "Enviado",
      SUCCESS: "Sucesso",
      FAILED: "Falhou",
      DISPUTED: "Em disputa",
      REFUNDED: "Reembolsado",
      INVALID: "Inválido",
      Unknown: "Desconhecido",
    },
    refund: {
      approval_pending: "Aguardando aprovação",
      pending: "Pendente",
      submitted: "Enviado",
      confirmed: "Confirmado",
      failed: "Falhou",
    },
    dispute: {
      open: "Aberta",
      under_review: "Em análise",
      resolved: "Resolvida",
      rejected: "Rejeitada",
    },
    result: {
      success: "Sucesso",
      failure: "Falha",
    },
    webhook: {
      active: "Ativo",
      inactive: "Inativo",
    },
  },

  errors: {
    // Student errors
    DUPLICATE_STUDENT: "Já existe um aluno com este ID.",
    STUDENT_NOT_FOUND: "Aluno não encontrado. Verifique o ID e tente novamente.",
    STUDENT_ID_GENERATION_FAILED: "Não foi possível gerar um ID de aluno. Tente novamente.",
    STUDENT_PREVIOUSLY_DELETED: "Este aluno foi excluído anteriormente e não pode ser recadastrado.",
    NO_FEE_STRUCTURE: "Nenhuma estrutura de mensalidades encontrada para esta turma. Configure uma primeiro.",

    // Payment errors
    SYNC_IN_PROGRESS: "Já existe uma sincronização em andamento. Aguarde e tente novamente.",
    DUPLICATE_TX: "Esta transação já foi registrada.",
    TX_FAILED: "A transação falhou na rede Stellar.",
    MISSING_MEMO: "A transação está sem o memo de ID do aluno obrigatório.",
    INVALID_DESTINATION: "A transação foi enviada para o endereço de carteira errado.",
    UNSUPPORTED_ASSET: "O pagamento foi feito em um ativo não suportado.",
    AMOUNT_TOO_LOW: "O valor do pagamento está abaixo do mínimo permitido.",
    AMOUNT_TOO_HIGH: "O valor do pagamento excede o máximo permitido.",
    UNDERPAID: "O valor do pagamento é menor que a mensalidade exigida.",
    PAYMENT_LOCKED: "Este pagamento está sendo processado. Aguarde.",
    INTENT_EXPIRED: "A sessão de pagamento expirou. Comece novamente.",
    INVALID_FEE_CATEGORY: "Categoria de mensalidade inválida.",

    // School errors
    DUPLICATE_SCHOOL: "Já existe uma escola com este nome ou slug.",
    SCHOOL_INACTIVE: "Esta conta de escola está inativa.",
    MISSING_SCHOOL_CONTEXT: "Falta o contexto da escola. Faça login novamente.",

    // Fee errors
    DUPLICATE_FEE_STRUCTURE: "Já existe uma estrutura de mensalidades para esta turma.",
    DUPLICATE_RULE: "Esta regra de ajuste já existe.",

    // Auth errors
    INVALID_CREDENTIALS: "E-mail ou senha incorretos.",
    INVALID_TOKEN: "Sua sessão é inválida. Faça login novamente.",
    INVALID_AUTH_TOKEN: "Sua sessão é inválida. Faça login novamente.",
    INVALID_REFRESH_TOKEN: "Sua sessão expirou. Faça login novamente.",
    MISSING_AUTH_TOKEN: "Autenticação necessária. Faça login.",
    MISSING_REFRESH_TOKEN: "Token de sessão ausente. Faça login novamente.",
    INSUFFICIENT_ROLE: "Você não tem permissão para realizar esta ação.",
    AUTH_MISCONFIGURED: "A autenticação está mal configurada. Entre em contato com o suporte.",

    // Dispute errors
    DISPUTE_ALREADY_EXISTS: "Já existe uma disputa para esta transação.",
    INVALID_TRANSITION: "Esta disputa não pode ser movida para o status solicitado.",

    // Validation errors
    VALIDATION_ERROR: "Alguns campos são inválidos. Verifique sua entrada.",
    INVALID_AMOUNT: "O valor informado não é válido.",
    INVALID_STELLAR_ADDRESS: "O endereço Stellar não é válido.",
    INVALID_WEBHOOK_URL: "A URL do webhook não é válida.",
    INVALID_TIMEZONE: "O fuso horário especificado não é válido.",
    INVALID_MEMO_FORMAT: "O formato do memo não é válido.",
    INVALID_HASH_FORMAT: "O formato do hash de transação não é válido.",
    INVALID_HASH_LENGTH: "O comprimento do hash de transação não é válido.",
    INVALID_HASH_TYPE: "O tipo de hash de transação não é válido.",
    INVALID_DATE_FORMAT: "O formato de data não é válido.",
    INVALID_SUSPICIOUS_PAYMENT_MULTIPLIER: "O valor do multiplicador de pagamento suspeito não é válido.",
    MISSING_HASH: "Um hash de transação é obrigatório.",
    MISSING_IDEMPOTENCY_KEY: "Uma chave de idempotência é necessária para esta solicitação.",
    CSV_INVALID_FORMAT: "O formato do arquivo CSV não é válido.",
    CSV_TOO_MANY_ROWS: "O arquivo CSV contém linhas demais.",
    CSV_TOO_LARGE: "O arquivo CSV é grande demais para ser processado.",

    // Stellar / Horizon errors
    STELLAR_NETWORK_ERROR: "A rede Stellar está indisponível no momento. Tente novamente mais tarde.",
    HORIZON_UNREACHABLE: "A rede Stellar está temporariamente indisponível. Verifique o status da rede e tente novamente mais tarde.",
    HORIZON_UNAVAILABLE: "A rede Stellar está temporariamente indisponível. Verifique o status da rede e tente novamente mais tarde.",
    tx_insufficient_fee: "A rede Stellar está congestionada e rejeitou a taxa de transação. Tente novamente em alguns minutos ou use uma taxa mais alta.",
    op_underfunded: "Saldo XLM insuficiente. Adicione XLM suficiente à sua carteira para cobrir o pagamento e a taxa de transação.",

    // Rate limiting / system errors
    RATE_LIMIT_EXCEEDED: "Muitas solicitações. Reduza o ritmo e tente novamente.",
    IP_BLOCKED: "Seu endereço IP foi bloqueado temporariamente.",
    QUEUE_FULL: "A fila de processamento está cheia. Tente novamente em breve.",
    NOT_FOUND: "O recurso solicitado não foi encontrado.",
    INTERNAL_ERROR: "Ocorreu um erro inesperado. Tente novamente.",
    SERVICE_UNAVAILABLE: "O serviço está temporariamente indisponível. Tente novamente mais tarde.",
    REQUEST_TIMEOUT: "A solicitação expirou. Tente novamente.",
    PROCESSING_ERROR: "Ocorreu um erro ao processar sua solicitação.",
    MAX_RETRIES_EXCEEDED: "Máximo de tentativas excedido. Tente novamente mais tarde.",
    CONFLICT: "Ocorreu um conflito com o estado atual. Atualize e tente novamente.",
    INVALID_LOG_LEVEL: "O nível de log especificado não é válido.",
    NO_PAYMENT_OPERATIONS: "Nenhuma operação de pagamento foi encontrada nesta transação.",
    DEDUP_ERROR: "Uma solicitação duplicada foi detectada.",
    NETWORK_ERROR: "Ocorreu um erro de rede. Verifique sua conexão.",
    UNKNOWN: "Ocorreu um erro inesperado. Tente novamente.",
  },

  payFees: {
    howItWorksTitle: "Como funciona",
    badge: "Seguro & Instantâneo",
    badgeSubtitle: "Mensalidades escolares liquidadas na rede Stellar",
    step1Title: "Digite o ID do aluno",
    step1Desc: "Consulte os detalhes do seu aluno e o status do pagamento.",
    step2Title: "Envie via Stellar",
    step2Desc: "Use qualquer carteira Stellar — escaneie o QR ou copie o endereço + memo.",
    step3Title: "Confirmação instantânea",
    step3Desc: "Seu pagamento é registrado on-chain em segundos.",
  },

  components: {
    testnetBanner: "TESTNET — Não envie fundos reais",
  },
};

export default pt;
