import type { UserConfig } from 'tsdown'

// 宿主自包含打包：把 @deepseek-ai/dsh-* 与 @a2a-js/sdk 等运行时依赖打进
// lib/index.js（node: 内置模块保持 external），让插件在任意 DSH 装配路径下加载。
const hostBundle: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    alwaysBundle: (id: string) => !id.startsWith('node:'),
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

export default hostBundle
