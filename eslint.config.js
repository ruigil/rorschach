import tseslint from 'typescript-eslint'

export default [
  {
    files: ['src/**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      // Syntax & Consistency Rules requested for rorschach
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      'prefer-arrow-callback': 'error',
      'func-style': ['error', 'expression'],
    },
  },
]
