import type { Metadata, Viewport } from "next";
import { Poppins } from "next/font/google";
import { Providers } from "@/components/providers";
import { AppSidebar } from "@/components/app-sidebar";
import "./globals.css";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "vtxo.fun",
  description: "Launch tokens on Nostr",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${poppins.variable} antialiased`}>
        <Providers>
          <AppSidebar />
          <main className="min-h-screen px-4 py-4 pb-24 md:ml-[60px] md:px-6 md:py-5 md:pb-5">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
