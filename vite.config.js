import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // 确保在 GitHub Pages 二级路径下能正确加载静态资源
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false
  },
  server: {
    port: 3000,
    open: false
  }
});
