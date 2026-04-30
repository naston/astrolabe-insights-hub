import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          // Vendored shadcn/ui primitives co-locate cva variants and a
          // single component-internal hook with the components themselves.
          // Whitelisting these names keeps shadcn's vendored shape intact
          // (so `npx shadcn add` updates don't fight our rules) without
          // losing the rule's value for our own app code.
          allowExportNames: [
            "buttonVariants",
            "badgeVariants",
            "toggleVariants",
            "navigationMenuTriggerStyle",
            "useFormField",
            "useSidebar",
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  eslintPluginPrettier,
);
