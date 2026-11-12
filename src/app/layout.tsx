import { ClerkProvider } from '@clerk/nextjs';
import type { ReactNode } from 'react';
import './style.css';

export const metadata = { title: 'Тінь Шарія', robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="uk"><body><ClerkProvider>{children}</ClerkProvider></body></html>;
}
