import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: '求职助手',
    short_name: '求职助手',
    description: '管理招聘机会、行动、材料、时间节点与求职复盘的本地工作台',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f4f7f8',
    theme_color: '#123e73',
    lang: 'zh-CN',
    icons: [
      {
        src: '/app-icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/app-icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}
