import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Процедуральный генератор подземелий — изометрическая ARPG на Three.js",
  description: "Детерминированный генератор подземелий с изометрическим рендерингом на Three.js: Делоне, MST, циклы, запечённый AO, факельный свет, поэтапная анимация сборки.",
  keywords: ["procedural generation", "Three.js", "isometric", "ARPG", "Delaunay", "dungeon", "WebGL"],
  authors: [{ name: "Z.ai" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Procedural Dungeon Generator",
    description: "Deterministic isometric dungeon generation + Three.js rendering",
    url: "https://chat.z.ai",
    siteName: "Z.ai",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Procedural Dungeon Generator",
    description: "Deterministic isometric dungeon generation + Three.js rendering",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
