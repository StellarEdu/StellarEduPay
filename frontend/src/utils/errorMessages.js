/**
 * Maps backend API error codes to human-readable messages for display in the UI.
 * Falls back to the raw message if no mapping exists.
 *
 * @param {string} code - The error code from the API response.
 * @param {string} [fallback] - Raw message to use if no mapping is found.
 * @returns {string} Human-readable error message.
 */

const ERROR_MESSAGES = {
  // Student errors
  DUPLICATE_STUDENT:           "A student with this ID already exists.",
  STUDENT_NOT_FOUND:           "Student not found. Please check the ID and try again.",
  STUDENT_ID_GENERATION_FAILED:"Could not generate a student ID. Please try again.",
  STUDENT_PREVIOUSLY_DELETED:  "This student was previously deleted and cannot be re-registered.",
  NO_FEE_STRUCTURE:            "No fee structure found for this class. Please set one up first.",

  // Payment errors
  SYNC_IN_PROGRESS:            "A sync is already in progress. Please wait and try again.",
  DUPLICATE_TX:                "This transaction has already been recorded.",
  TX_FAILED:                   "The transaction failed on the Stellar network.",
  MISSING_MEMO:                "The transaction is missing the required student ID memo.",
  INVALID_DESTINATION:         "The transaction was sent to the wrong wallet address.",
  UNSUPPORTED_ASSET:           "Payment was made in an unsupported asset.",
  AMOUNT_TOO_LOW:              "Payment amount is below the minimum allowed.",
  AMOUNT_TOO_HIGH:             "Payment amount exceeds the maximum allowed.",
  UNDERPAID:                   "Payment amount is less than the required fee.",
  STELLAR_NETWORK_ERROR:       "The Stellar network is currently unavailable. Please try again later.",
  PAYMENT_LOCKED:              "This payment is currently being processed. Please wait.",
  INTENT_EXPIRED:              "The payment session has expired. Please start again.",
  INVALID_FEE_CATEGORY:        "Invalid fee category specified.",

  // School errors
  DUPLICATE_SCHOOL:            "A school with this name or slug already exists.",
  SCHOOL_INACTIVE:             "This school account is inactive.",
  MISSING_SCHOOL_CONTEXT:      "School context is missing. Please log in again.",

  // Fee errors
  DUPLICATE_FEE_STRUCTURE:     "A fee structure for this class already exists.",
  DUPLICATE_RULE:              "This adjustment rule already exists.",

  // Auth errors
  INVALID_CREDENTIALS:         "Incorrect email or password.",
  INVALID_TOKEN:               "Your session is invalid. Please log in again.",
  INVALID_AUTH_TOKEN:          "Your session is invalid. Please log in again.",
  INVALID_REFRESH_TOKEN:       "Your session has expired. Please log in again.",
  MISSING_AUTH_TOKEN:          "Authentication required. Please log in.",
  MISSING_REFRESH_TOKEN:       "Session token missing. Please log in again.",
  INSUFFICIENT_ROLE:           "You do not have permission to perform this action.",
  AUTH_MISCONFIGURED:          "Authentication is misconfigured. Please contact support.",

  // Dispute errors
  DISPUTE_ALREADY_EXISTS:      "A dispute for this transaction already exists.",
  INVALID_TRANSITION:          "This dispute cannot be moved to the requested status.",

  // Validation errors
  VALIDATION_ERROR:            "Some fields are invalid. Please check your input.",
  INVALID_AMOUNT:              "The amount entered is not valid.",
  INVALID_STELLAR_ADDRESS:     "The Stellar address is not valid.",
  INVALID_WEBHOOK_URL:         "The webhook URL is not valid.",
  INVALID_TIMEZONE:            "The timezone specified is not valid.",
  INVALID_MEMO_FORMAT:         "The memo format is not valid.",
  INVALID_HASH_FORMAT:         "The transaction hash format is not valid.",
  INVALID_HASH_LENGTH:         "The transaction hash length is not valid.",
  INVALID_HASH_TYPE:           "The transaction hash type is not valid.",
  INVALID_DATE_FORMAT:         "The date format is not valid.",
  INVALID_SUSPICIOUS_PAYMENT_MULTIPLIER: "The suspicious payment multiplier value is not valid.",
  MISSING_HASH:                "A transaction hash is required.",
  MISSING_IDEMPOTENCY_KEY:     "An idempotency key is required for this request.",
  CSV_INVALID_FORMAT:          "The CSV file format is not valid.",
  CSV_TOO_MANY_ROWS:           "The CSV file contains too many rows.",
  CSV_TOO_LARGE:               "The CSV file is too large to process.",

  // Rate limiting / system errors
  RATE_LIMIT_EXCEEDED:         "Too many requests. Please slow down and try again.",
  IP_BLOCKED:                  "Your IP address has been temporarily blocked.",
  QUEUE_FULL:                  "The processing queue is full. Please try again shortly.",
  NOT_FOUND:                   "The requested resource was not found.",
  INTERNAL_ERROR:              "An unexpected error occurred. Please try again.",
  SERVICE_UNAVAILABLE:         "The service is temporarily unavailable. Please try again later.",
  REQUEST_TIMEOUT:             "The request timed out. Please try again.",
  PROCESSING_ERROR:            "An error occurred while processing your request.",
  MAX_RETRIES_EXCEEDED:        "Maximum retry attempts exceeded. Please try again later.",
  CONFLICT:                    "A conflict occurred with the current state. Please refresh and try again.",
  INVALID_LOG_LEVEL:           "The log level specified is not valid.",
  NO_PAYMENT_OPERATIONS:       "No payment operations were found in this transaction.",
  DEDUP_ERROR:                 "A duplicate request was detected.",
  NETWORK_ERROR:               "A network error occurred. Please check your connection.",
};

/**
 * Returns a human-readable message for the given error code.
 * Falls back to the raw message string, or a generic error if neither is available.
 */
export function getErrorMessage(code, fallback) {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  if (fallback && typeof fallback === "string" && fallback.trim()) return fallback;
  return "An unexpected error occurred. Please try again.";
}

export default ERROR_MESSAGES;
