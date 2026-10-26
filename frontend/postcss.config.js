import { fileURLToPath } from "url";

export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL("./tailwind.config.cjs", import.meta.url)) },
    autoprefixer: {},
  },
};
