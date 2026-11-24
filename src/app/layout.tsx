import type { Metadata, Viewport } from "next";
import { Anuphan } from "next/font/google";
import "./globals.css";

const anuphan = Anuphan({ subsets: ["thai", "latin"], variable: "--font-anuphan" });

export const metadata: Metadata = { title: "ระบบจัดการรถ" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#2563eb" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={anuphan.variable}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
