import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '求职助手',
  description: '个人求职信息、材料、时间与招聘流程管理工具',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
