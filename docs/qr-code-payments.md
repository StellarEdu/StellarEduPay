# QR Code Payment Feature

## Overview

The QR code payment feature allows parents to scan a QR code with their Stellar-compatible mobile wallet to automatically populate payment details, eliminating manual entry errors.

## Implementation

### Stellar Payment URI (SEP-0007)

The QR code encodes a Stellar payment URI following the [SEP-0007 specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md):

```
web+stellar:pay?destination=<WALLET_ADDRESS>&amount=<AMOUNT>&memo=<MEMO>&memo_type=MEMO_TEXT
```

### Components

1. **stellarUri.js** - Utility function to generate SEP-0007 compliant payment URIs
2. **stellarMemo.js** - Encodes/decodes the payment reference across memo types
3. **PaymentForm.jsx** - Updated to display QR code after student lookup
4. **qrcode.react** - Library used to render QR codes as SVG

### Memo types

Most wallets accept a free-text memo, but some — particularly exchange-style and
programmatic integrations — can only send a numeric or hash memo. The QR code
therefore offers the payment reference in three interchangeable forms:

| Memo type   | Wire form for reference `A3F91B2C` | Notes |
| ----------- | ---------------------------------- | ----- |
| `MEMO_TEXT` | `A3F91B2C`                         | Default. Sent verbatim, 28-byte on-chain limit. |
| `MEMO_ID`   | `2751011628`                       | The same 32-bit value as an unsigned decimal. |
| `MEMO_HASH` | 32 bytes, base64                   | The value right-aligned in 32 bytes, zero-padded. |

All three decode back to the identical reference, so payment matching stays a
single lookup — there is no separate matching path per type. A memo type is only
offered when the memo can actually be represented in it: a free-text memo such as
a raw student ID has no numeric equivalent and is `MEMO_TEXT` only.

`MEMO_RETURN` is **not** supported. It carries a 32-byte hash for refund routing
and has no payment-reference encoding.

Decoding deliberately rejects values that merely *look* plausible: a `MEMO_ID`
above the 32-bit reference space (exchanges routinely use large routing IDs) and
a `MEMO_HASH` whose padding bytes are non-zero both fail to decode rather than
being truncated into a false match against an unrelated payment.

The backend decoder in `backend/src/utils/stellarMemo.js` mirrors the frontend
encoder. The two must stay in sync; `backend/tests/stellarMemo.test.js` pins the
exact wire forms the frontend produces so a drift in either direction fails CI.

### Features

- Automatically includes wallet address, payment amount, and memo
- Works with both testnet and mainnet
- Supports multiple asset types (XLM, USDC, etc.)
- Displays explanatory text for users
- Responsive design with centered layout

## Usage

1. Parent enters student ID
2. System displays payment instructions including QR code
3. Parent opens Stellar wallet app (e.g., Lobstr, Solar, Freighter)
4. Parent scans QR code
5. Wallet automatically fills in:
   - Destination address
   - Payment amount
   - Memo text
6. Parent confirms and sends payment

## Compatible Wallets

The following Stellar wallets support SEP-0007 payment URIs:

- Lobstr
- Solar Wallet
- Freighter (browser extension with mobile support)
- XBULL Wallet
- Vibrant

## Testing

### Manual Testing

1. Start the frontend: `npm run dev` (in frontend directory)
2. Look up a student with unpaid fees
3. Verify QR code appears below payment instructions
4. Scan with a Stellar wallet app to verify fields are pre-filled

### Automated Testing

Run the unit tests for URI generation:

```bash
cd frontend
npm test -- stellarUri.test.js
```

## Network Compatibility

The QR code works correctly for both:
- **Testnet**: Uses testnet wallet addresses and Horizon URL
- **Mainnet**: Uses mainnet wallet addresses and Horizon URL

The network is determined by the backend configuration (`STELLAR_NETWORK` environment variable).

## Security Considerations

- QR codes are generated client-side from API response data
- No sensitive information is exposed beyond what's already in payment instructions
- Memo encryption (if enabled) is handled server-side before the data reaches the frontend
- URI generation validates required fields to prevent malformed QR codes

## Future Enhancements

- Add download/share QR code functionality
- Dynamic QR code sizing based on screen size
- Print-friendly QR code format for paper invoices
