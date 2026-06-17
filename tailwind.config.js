/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx}', './src/**/*.{js,ts,jsx,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f0e9ff',
          100: '#ddd0ff',
          200: '#c4a8ff',
          300: '#a87aff',
          400: '#8b4fff',
          500: '#6c28e8',
          600: '#5518c8',
          700: '#420ea3',
          800: '#310a7d',
          900: '#1a0a2e',
        },
        amber: {
          400: '#fbbf24',
          500: '#f59e0b',
        },
        surface: '#ffffff',
        muted: '#6b7280',
      },
      fontFamily: {
        sans: ['System'],
      },
    },
  },
  plugins: [],
};
