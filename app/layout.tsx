import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./leftovers.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://naeil-bbang.vercel.app"),
  title: "내일의 빵 · 모델 비교 연구실",
  description: "전체 102회 비교 실험과 내가 만든 최종 모델의 성적을 확인하고, 실제 매장 기록으로 내일 생산량을 비교하세요.",
  applicationName: "내일의 빵",
  appleWebApp: { capable: true, title: "내일의 빵", statusBarStyle: "default" },
  openGraph: {
    title: "내일의 빵 · 모델 비교 연구실",
    description: "전체 비교 실험부터 내 매장의 실제 예측 성적까지.",
    locale: "ko_KR",
    type: "website",
    images: [{ url: "/brand/icon-512.png", width: 512, height: 512, alt: "내일의 빵 앱 아이콘" }],
  },
  icons: {
    icon: [{ url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/brand/icon-192.png", sizes: "192x192", type: "image/png" }],
    shortcut: "/brand/favicon-32.png",
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = { themeColor: "#c74916" };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
