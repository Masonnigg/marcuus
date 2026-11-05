// Bundles the caption rules for the Premiere panel (CommonJS, Node built-ins only).
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: 'src/lib/panelCaptions.js', formats: ['cjs'], fileName: () => 'captions.cjs' },
    outDir: 'premiere/lib',
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
  },
});
