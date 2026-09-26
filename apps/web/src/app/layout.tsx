import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SkinCRM",
  description: "Clinic lead and appointment CRM",
  // Staff records are never content a search engine should hold.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
