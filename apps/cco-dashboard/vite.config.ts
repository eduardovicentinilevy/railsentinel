import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base relativo: o build final (dist/) pode ser aberto direto do disco
// ou servido de qualquer subpasta, sem depender de um domínio fixo.
export default defineConfig({
  base: './',
  plugins: [react()],
});
