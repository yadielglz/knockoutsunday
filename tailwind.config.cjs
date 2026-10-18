module.exports = {
      content: ['./index.html', './app.js'],
      theme: {
        extend: {
          fontFamily: {
            display: ['"Bebas Neue"', 'sans-serif'],
            sans: ['Inter', 'sans-serif'],
            mono: ['"JetBrains Mono"', 'monospace'],
          },
          colors: {
            magenta: {
              DEFAULT: '#E20074',
              dark: '#A80055',
              light: '#FF2A95',
              glow: 'rgba(226, 0, 116, 0.45)',
            },
            arena: {
              bg: '#09090E',
              card: '#12131C',
              border: '#252738',
              elevated: '#191B28',
            }
          }
        }
      }
    };
