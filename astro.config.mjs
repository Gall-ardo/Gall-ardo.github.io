import { defineConfig } from 'astro/config';

// GitHub Pages-compatible config.
// If deploying to https://<user>.github.io/ (user/organization site), keep `base: '/'`.
// If deploying to https://<user>.github.io/<repo>/ (project site), set `base: '/<repo>/'`.
export default defineConfig({
  site: 'https://gall-ardo.github.io',
  base: '/',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
});
