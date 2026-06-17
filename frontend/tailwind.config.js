/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Inter for UI chrome + data; SF Pro as Apple-native fallback on macOS/iOS
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        // Display stack mirrors apple.com headings (SF Pro Display → Inter)
        display: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
      fontSize: {
        // Matched to apple.com type scale (rem values)
        'xs':   ['0.6875rem', { lineHeight: '1rem',    letterSpacing: '0.01em'  }],
        'sm':   ['0.8125rem', { lineHeight: '1.25rem', letterSpacing: '0em'     }],
        'base': ['0.9375rem', { lineHeight: '1.5rem',  letterSpacing: '0em'     }],
        'lg':   ['1.0625rem', { lineHeight: '1.5rem',  letterSpacing: '-0.01em' }],
        'xl':   ['1.1875rem', { lineHeight: '1.625rem',letterSpacing: '-0.015em'}],
        '2xl':  ['1.375rem',  { lineHeight: '1.75rem', letterSpacing: '-0.02em' }],
        '3xl':  ['1.75rem',   { lineHeight: '2rem',    letterSpacing: '-0.025em'}],
      },
      colors: {
        // Remap the slate palette to Apple's neutral scale so every existing
        // text-slate-* / bg-slate-* class renders Apple-matching colours.
        slate: {
          50:  '#f5f5f7',  // --color-surface    (apple.com body bg)
          100: '#f5f5f7',
          200: '#d2d2d7',  // --color-border     (apple.com dividers)
          300: '#d2d2d7',
          400: '#aeaeb2',  // --color-text-tertiary
          500: '#6e6e73',  // --color-text-secondary
          600: '#6e6e73',
          700: '#1d1d1f',  // --color-text-primary
          800: '#1d1d1f',
          900: '#1d1d1f',
          950: '#111113',
        },
        // Apple accent blue
        blue: {
          50:  '#e8f0fd',
          100: '#d1e2fc',
          400: '#47a3ff',
          500: '#0071e3',
          600: '#0071e3',
          700: '#0077ed',
          800: '#006edb',
        },
      },
      letterSpacing: {
        tighter: '-0.025em',
        tight:   '-0.015em',
        snug:    '-0.01em',
        normal:  '0em',
        wide:    '0.01em',
        wider:   '0.04em',   // used for uppercase labels
        widest:  '0.08em',
      },
    },
  },
  plugins: [],
}
