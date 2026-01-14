/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{ts,tsx,js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',

        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },

        // Brand tokens
        'brand': {
          50: '#f0f4f8',
          100: '#d9e2ec',
          500: '#243b53', // Primary Navy
          600: '#102a43',
          900: '#061021', // Deepest Navy
        },
        'action': {
          500: '#27ab83', // Emerald Green (Buttons)
          600: '#199473',
        },
        'gold': {
          500: '#d69e2e', // Premium Accent
        },
        'surface': {
          DEFAULT: '#ffffff',
          muted: '#f8fafc', // Slate-50
        },

        'brand-primary': 'hsl(var(--brand-primary))',
        'brand-accent': 'hsl(var(--brand-accent))',
        'brand-light': 'hsl(var(--brand-light))',
        'brand-highlight': 'hsl(var(--brand-highlight))',
        'brand-surface': 'hsl(var(--brand-surface))',
      },
      borderRadius: {
        DEFAULT: '0.375rem', // 6px
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        'subtle': '0 1px 2px 0 rgba(36, 59, 83, 0.05)',
        'card': '0 4px 6px -1px rgba(36, 59, 83, 0.1), 0 2px 4px -1px rgba(36, 59, 83, 0.06)',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      container: {
        center: true,
        padding: '1rem',
        screens: {
          '2xl': '1200px',
        },
      },
    },
  },
  plugins: [],
};
