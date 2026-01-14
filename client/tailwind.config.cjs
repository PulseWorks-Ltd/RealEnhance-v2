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

        // ===== BRAND DESIGN SYSTEM =====
        // Navy scale (primary brand)
        'brand': {
          50: '#f0f4f8',
          100: '#d9e2ec',
          200: '#bcccdc',
          300: '#9fb3c8',
          400: '#829ab1',
          500: '#243b53', // Primary Navy
          600: '#102a43',
          700: '#0d2137',
          800: '#091a2b',
          900: '#061021', // Deepest Navy
        },
        // Emerald action (CTAs, success)
        'action': {
          50: '#e6f7f1',
          100: '#c3ead9',
          400: '#3dc99b',
          500: '#27ab83', // Primary Emerald
          600: '#199473',
          700: '#127a5f',
        },
        // Gold accent (premium, warnings)
        'gold': {
          50: '#fefbea',
          100: '#fef3c7',
          400: '#f6c244',
          500: '#d69e2e', // Premium Accent
          600: '#b7791f',
        },
        // Surface tokens
        'surface': {
          DEFAULT: '#ffffff',
          muted: '#f8fafc',
          subtle: '#f1f5f9',
        },
        // Status semantic colors
        'status': {
          success: '#27ab83',
          warning: '#d69e2e',
          error: '#dc2626',
          info: '#3b82f6',
          processing: '#8b5cf6',
        },

        // CSS variable-based brand tokens
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
        'elevated': '0 10px 25px -5px rgba(36, 59, 83, 0.1), 0 8px 10px -6px rgba(36, 59, 83, 0.05)',
        'glow': '0 0 20px rgba(39, 171, 131, 0.15)',
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
      // Consistent spacing rhythm
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
      },
      // Animation presets
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-subtle': 'pulseSubtle 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
      },
    },
  },
  plugins: [],
};
