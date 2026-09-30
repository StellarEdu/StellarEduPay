/**
 * Test fixtures for Stellar path payment operations.
 *
 * Path payments deliver funds to the destination wallet using a different
 * source asset than the one received. On the Horizon operation record the
 * `asset_code` / `asset_issuer` / `amount` fields describe the asset and
 * amount actually received by the destination, while `source_asset_*` and
 * `source_amount` describe what the sender spent.
 *
 * These fixtures cover both path payment operation types so payment
 * detection can credit the destination asset/amount for a school wallet.
 */

const SCHOOL_WALLET = "GSCHOOLWALLETADDRESS000000000000000000000000000000000000";
const PARENT_WALLET = "GPARENTWALLETADDRESS000000000000000000000000000000000000";

const USDC_ISSUER = "GUSDCISSUERADDRESS0000000000000000000000000000000000000";
const XLM_NATIVE = "native";

/**
 * path_payment_strict_send: the sender specifies the exact source amount to
 * send (XLM) and the destination receives a variable amount of USDC.
 */
const pathPaymentStrictSend = {
  id: "op-path-strict-send-0001",
  paging_token: "op-path-strict-send-0001",
  transaction_hash: "txhashpathstrictsend0000000000000000000000000000000000000000000001",
  type: "path_payment_strict_send",
  type_i: 13,
  created_at: "2024-01-15T10:00:00Z",
  transaction_successful: true,
  source_account: PARENT_WALLET,
  from: PARENT_WALLET,
  to: SCHOOL_WALLET,
  // Destination asset/amount actually received by the school wallet.
  asset_type: "credit_alphanum4",
  asset_code: "USDC",
  asset_issuer: USDC_ISSUER,
  amount: "100.0000000",
  // Source asset/amount spent by the parent.
  source_asset_type: XLM_NATIVE,
  source_amount: "850.0000000",
  path: [],
};

/**
 * path_payment_strict_receive: the sender specifies the exact destination
 * amount to deliver (USDC) and spends a variable amount of XLM.
 */
const pathPaymentStrictReceive = {
  id: "op-path-strict-receive-0001",
  paging_token: "op-path-strict-receive-0001",
  transaction_hash: "txhashpathstrictreceive00000000000000000000000000000000000000000001",
  type: "path_payment_strict_receive",
  type_i: 2,
  created_at: "2024-01-15T10:05:00Z",
  transaction_successful: true,
  source_account: PARENT_WALLET,
  from: PARENT_WALLET,
  to: SCHOOL_WALLET,
  // Destination asset/amount actually received by the school wallet.
  asset_type: "credit_alphanum4",
  asset_code: "USDC",
  asset_issuer: USDC_ISSUER,
  amount: "250.0000000",
  // Source asset/amount spent by the parent.
  source_asset_type: XLM_NATIVE,
  source_amount: "2125.0000000",
  path: [],
};

/**
 * A path payment whose destination is NOT the school wallet. Used to assert
 * that unrelated path payments are ignored by payment detection.
 */
const pathPaymentOtherDestination = {
  id: "op-path-other-destination-0001",
  paging_token: "op-path-other-destination-0001",
  transaction_hash: "txhashpathotherdestination0000000000000000000000000000000000000000001",
  type: "path_payment_strict_send",
  type_i: 13,
  created_at: "2024-01-15T10:10:00Z",
  transaction_successful: true,
  source_account: PARENT_WALLET,
  from: PARENT_WALLET,
  to: "GOTHERWALLETADDRESS000000000000000000000000000000000000000",
  asset_type: "credit_alphanum4",
  asset_code: "USDC",
  asset_issuer: USDC_ISSUER,
  amount: "75.0000000",
  source_asset_type: XLM_NATIVE,
  source_amount: "640.0000000",
  path: [],
};

/**
 * A path payment delivering an asset the school does not accept. Used to
 * assert that the destination asset is validated against accepted assets.
 */
const pathPaymentUnacceptedAsset = {
  id: "op-path-unaccepted-asset-0001",
  paging_token: "op-path-unaccepted-asset-0001",
  transaction_hash: "txhashpathunacceptedasset0000000000000000000000000000000000000000001",
  type: "path_payment_strict_receive",
  type_i: 2,
  created_at: "2024-01-15T10:15:00Z",
  transaction_successful: true,
  source_account: PARENT_WALLET,
  from: PARENT_WALLET,
  to: SCHOOL_WALLET,
  asset_type: "credit_alphanum4",
  asset_code: "SHIB",
  asset_issuer: "GSHIBISSUERADDRESS0000000000000000000000000000000000000",
  amount: "1000000.0000000",
  source_asset_type: XLM_NATIVE,
  source_amount: "500.0000000",
  path: [],
};

/**
 * Wrap an operation in a Horizon-style transaction record so tests can feed
 * it through transaction verification / payment extraction.
 */
function asTransaction(operation, overrides = {}) {
  return {
    id: operation.transaction_hash,
    hash: operation.transaction_hash,
    successful: true,
    memo_type: "text",
    memo: "SCHOOL-12345",
    created_at: operation.created_at,
    operations: [operation],
    ...overrides,
  };
}

module.exports = {
  SCHOOL_WALLET,
  PARENT_WALLET,
  USDC_ISSUER,
  XLM_NATIVE,
  pathPaymentStrictSend,
  pathPaymentStrictReceive,
  pathPaymentOtherDestination,
  pathPaymentUnacceptedAsset,
  asTransaction,
};
