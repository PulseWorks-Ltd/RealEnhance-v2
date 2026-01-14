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
          50: '#f8fafc', // Slate 50
          100: '#f1f5f9', // Slate 100
          200: '#e2e8f0', // Slate 200
          300: '#cbd5e1', // Slate 300
          400: '#94a3b8', // Slate 400
          500: '#64748b', // Slate 500
          600: '#475569', // Slate 600
          700: '#334155', // Slate 700 (Brand Light)
          800: '#1e293b', // Slate 800
          900: '#0f172a', // Slate 900 (Brand Default)
          950: '#020617', // Slate 950
        },
        // Emerald action (CTAs, success)
        'action': {
          50: '#ecfdf5',
          100: '#d1fae5', // Light highlight
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669', // Primary Action/Success
          700: '#047857', // Hover state
          800: '#065f46',
          900: '#064e3b',
        },
        // Gold accent (premium, warnings)
        'gold': {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b', // Accent Default
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
        },
        // Surface tokens
        'surface': {
          DEFAULT: '#ffffff',
          page: '#F8FAFC',    // Slate 50
          card: '#FFFFFF',    // White
          border: '#E2E8F0',  // Slate 200
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
        serif: ['"Playfair Display"', 'serif'],
      },
      borderRadius: {
        'xs': '4px',
        'sm': '6px',
        DEFAULT: '8px',
        'md': '8px',
        'lg': '12px',
        'xl': '16px',
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
