/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        wopr: {
          bg: '#0d1117',
          surface: '#161b22',
          surface2: '#21262d',
          surface3: '#2d333b',
          border: '#30363d',
          borderLight: '#444c56',
          accent: '#4c9ffe',
          accentHover: '#388bfd',
          accentGlow: 'rgba(76, 159, 254, 0.15)',
          ok: '#3fb950',
          okGlow: 'rgba(63, 185, 80, 0.15)',
          warn: '#d29922',
          warnGlow: 'rgba(210, 153, 34, 0.15)',
          err: '#f85149',
          errGlow: 'rgba(248, 81, 73, 0.15)',
          inactive: '#6e7681',
          text: '#e6edf3',
          textMuted: '#8b949e',
          textSubtle: '#6e7681',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
