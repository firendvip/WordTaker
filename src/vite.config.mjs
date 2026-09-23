import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { getManualChunkName } from './helpers/viteChunkPolicy.mjs'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react()
  ],
  
  // 开发服务器配置
  server: {
    port: 5173,
    host: 'localhost',
    strictPort: true,
    cors: true
  },
  
  // 构建配置
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: process.env.NODE_ENV === 'development',
    minify: 'oxc',
    target: 'chrome120', // Electron使用的Chrome版本
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        history: path.resolve(import.meta.dirname, 'history.html'),
        settings: path.resolve(import.meta.dirname, 'settings.html')
      },
      output: {
        manualChunks: getManualChunkName
      }
    },
    // 优化配置
    chunkSizeWarningLimit: 1000
  },
  
  // 路径别名
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '.'),
      '@/components': path.resolve(import.meta.dirname, 'components'),
      '@/hooks': path.resolve(import.meta.dirname, 'hooks'),
      '@/services': path.resolve(import.meta.dirname, 'services'),
      '@/utils': path.resolve(import.meta.dirname, 'utils'),
      '@/assets': path.resolve(import.meta.dirname, '../assets')
    }
  },
  
  // 环境变量配置
  envPrefix: ['VITE_', 'ELECTRON_'],
  
  // CSS配置
  css: {
    devSourcemap: true,
    postcss: '../postcss.config.js',
    preprocessorOptions: {
      scss: {
        additionalData: `@import "@/styles/variables.scss";`
      }
    }
  },
  
  // 优化依赖
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'lucide-react',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-select',
      '@radix-ui/react-label',
      '@radix-ui/react-progress',
      '@radix-ui/react-slot',
      '@radix-ui/react-tabs'
    ],
    exclude: ['electron']
  },
  
  // 定义全局常量
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __DEV__: process.env.NODE_ENV === 'development'
  },
  
  // 基础路径配置
  base: './',
  
  // 公共目录
  publicDir: '../assets',
  
  // 清除控制台
  clearScreen: false,
  
  // 日志级别
  logLevel: 'info',
  
  // 预览配置
  preview: {
    port: 4173,
    host: 'localhost',
    strictPort: true
  }
})
