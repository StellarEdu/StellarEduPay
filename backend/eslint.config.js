import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Monetary amounts must be exact. Stellar amounts are 7-decimal fixed-point
    // values (int64 stroops); doing float arithmetic on them introduces rounding
    // error. Use the helpers in utils/stellarAmount.js instead of parseFloat/toFixed.
    files: ['src/**/*.js'],
    ignores: ['src/utils/stellarAmount.js', 'src/**/__tests__/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'Do not parse money with parseFloat. Use utils/stellarAmount.js (toStroops/fromStroops) for exact 7-decimal amounts.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message:
            'Do not parse money with Number.parseFloat. Use utils/stellarAmount.js (toStroops/fromStroops) for exact 7-decimal amounts.',
        },
        {
          object: 'Number',
          property: 'parseInt',
          message:
            'Do not parse money with Number.parseInt. Use utils/stellarAmount.js (toStroops/fromStroops) for exact 7-decimal amounts.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='toFixed']",
          message:
            'Do not round money with toFixed. Store amounts as integer stroops and use utils/stellarAmount.js for conversion.',
        },
        // ── #1743: forbid findById* on tenant-scoped models ──────────────
        // The tenantScope plugin throws TenantScopeError when a query lacks
        // schoolId. Mongoose implements findById(id) as findOne({ _id: id }),
        // which never carries schoolId, so every findById* call on a
        // tenant-scoped model throws at runtime. Use findOne({ _id, schoolId })
        // or findOneAndUpdate({ _id, schoolId }, ...) instead.
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='findById'] > MemberExpression.object Identifier[name=/^(Payment|Student|Refund|Dispute|PaymentIntent|Receipt|EmailDelivery|PendingVerification|PaymentPlan|FeeAdjustmentRule|AuditLog|ReminderLog|FeeStructure|ReconciliationReport|StudentFeeHistory)$/]",
          message:
            'Do not use findById on a tenant-scoped model — the tenantScope plugin throws because the filter has no schoolId. Use Model.findOne({ _id, schoolId }) instead.',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='findByIdAndUpdate'] > MemberExpression.object Identifier[name=/^(Payment|Student|Refund|Dispute|PaymentIntent|Receipt|EmailDelivery|PendingVerification|PaymentPlan|FeeAdjustmentRule|AuditLog|ReminderLog|FeeStructure|ReconciliationReport|StudentFeeHistory)$/]",
          message:
            'Do not use findByIdAndUpdate on a tenant-scoped model — the tenantScope plugin throws because the filter has no schoolId. Use Model.findOneAndUpdate({ _id, schoolId }, ...) instead.',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='findByIdAndDelete'] > MemberExpression.object Identifier[name=/^(Payment|Student|Refund|Dispute|PaymentIntent|Receipt|EmailDelivery|PendingVerification|PaymentPlan|FeeAdjustmentRule|AuditLog|ReminderLog|FeeStructure|ReconciliationReport|StudentFeeHistory)$/]",
          message:
            'Do not use findByIdAndDelete on a tenant-scoped model — the tenantScope plugin throws because the filter has no schoolId. Use Model.findOneAndDelete({ _id, schoolId }) instead.',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='findByIdAndReplace'] > MemberExpression.object Identifier[name=/^(Payment|Student|Refund|Dispute|PaymentIntent|Receipt|EmailDelivery|PendingVerification|PaymentPlan|FeeAdjustmentRule|AuditLog|ReminderLog|FeeStructure|ReconciliationReport|StudentFeeHistory)$/]",
          message:
            'Do not use findByIdAndReplace on a tenant-scoped model — the tenantScope plugin throws because the filter has no schoolId. Use Model.findOneAndReplace({ _id, schoolId }, ...) instead.',
        },
      ],
    },
  },
];
