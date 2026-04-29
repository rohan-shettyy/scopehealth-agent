import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prescription Refill Voice Agent",
  description: "Local demo scaffold for a prescription refill voice agent"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
