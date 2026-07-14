/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0a0e14",
          900: "#0f141c",
          850: "#131a24",
          800: "#1a2230",
          700: "#242e40",
          600: "#38455c",
        },
        accent: {
          DEFAULT: "#22d3ee",
          dim: "#0e7490",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
