import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import i18next from "eslint-plugin-i18next";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals"),
  // Issue #2025: user-facing JSX text in pages and components must go through
  // i18n. Brand names and symbols are allow-listed. Warn-level until the
  // existing hard-coded strings are migrated, then promote to "error".
  {
    files: ["src/pages/**/*.{js,jsx}", "src/components/**/*.{js,jsx}"],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": [
        "warn",
        {
          mode: "jsx-text-only",
          words: {
            exclude: ["StellarEduPay", "Stellar", "XLM", "SEP-0007", "Lobstr", "Solar", "XBULL", "Testnet", "PNG", "QR", "CSV", "PDF", "^[^A-Za-z]*$"],
          },
        },
      ],
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "out/**", "build/**"],
  },
];

export default eslintConfig;
